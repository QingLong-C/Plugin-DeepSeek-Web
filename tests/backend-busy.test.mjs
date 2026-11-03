import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setup, input, collect, frame, snapshot, sse } from './helpers/fixture.mjs'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
import { loggedBackendBusyRejection } from '../lib/local/rate-rejection.js'
import { LocalStore } from '../lib/local/store.js'
import { SessionEngine } from '../lib/core/session.js'
import { decodeResponse } from '../lib/core/codec.js'

const hint = { type: 'error', clear_response: true, finish_reason: 'backend_busy', content: '服务器繁忙，请稍后重试' }
const reject = (f, c) => {
  f.web.chats.set(c.body.chat_session_id, f.web.chats.get(c.body.chat_session_id).filter(m => ![c.requestId, c.responseId].includes(m.message_id)))
  return sse(c.ready + frame(hint, 'hint'))
}

test('explicit backend busy waits and completes the same native attempt without replaying delivered work', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false))
  try {
    const times = [], states = []
    f.web.completion = async c => {
      times.push(Date.now()); states.push(await f.pending())
      return times.length < 3 ? reject(f, c) : sse(c.ready + frame(snapshot(c.text)))
    }
    const events = await f.run(), result = events.find(e => e.type === 'result')
    assert(result); assert.equal(times.length, 3)
    assert(times[1] - times[0] >= 5); assert(times[2] - times[1] >= 10)
    assert.equal(new Set(states.map(s => s.id)).size, 1)
    assert.equal(new Set(states.map(s => s.native.attemptId)).size, 1)
    assert.equal(new Set(f.web.generations.map(g => g.prompt)).size, 1)
    assert.equal(new Set(f.web.generations.map(g => g.parent_message_id)).size, 1)
    assert.equal(events.filter(e => e.type === 'withdraw').length, 0)
    assert.equal(f.web.resumes.length, 0); assert.equal(f.web.stops.length, 0)
    f.native.save(result); await f.engine.reconcile('session-1'); assert.equal(await f.pending(), undefined)
    const gate = JSON.parse(await readFile(join(f.home, 'requests', f.accountKey + '.json'), 'utf8'))
    assert.deepEqual(gate.flights, []); assert.equal(gate.strikes, 0)
  } finally { await f.close() }
})

test('legacy busy fence needs exact private journal, failed native attempt and fresh absence before another session can proceed', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false))
  try {
    // Accepted history refuses automatic retry; then emulate the old, absent busy response.
    f.web.completion = c => sse(c.ready + frame(hint, 'hint'))
    await assert.rejects(f.run()); await f.log.flush()
    const op = await f.pending(); assert.equal(await loggedBackendBusyRejection(f.home, op), true)
    f.web.chats.set(op.chatId, [])
    const file = join(f.home, 'sessions', op.sessionKey + '.json'), state = JSON.parse(await readFile(file, 'utf8'))
    delete state.active.knownRejected; delete state.active.verifiedPath; state.active.stage = 'uncertain'
    await writeFile(file, JSON.stringify(state), { mode: 0o600 })
    const gateFile = join(f.home, 'requests', f.accountKey + '.json'), gate = JSON.parse(await readFile(gateFile, 'utf8'))
    const { id, sessionKey, chatId, parentId, promptHash, identity } = op
    gate.flights = [{ id, sessionKey, chatId, parentId, promptHash, identity }]
    await writeFile(gateFile, JSON.stringify(gate), { mode: 0o600 })
    f.web.completion = undefined
    await assert.rejects(f.run(input([], 'other-session')), e => e.code === 'PENDING_OPERATION')
    assert.equal(f.web.generations.length, 1)
    f.native.cancel(op.native)
    const result = (await f.run(input([], 'other-session'))).find(e => e.type === 'result'); assert(result)
    assert.equal(f.web.generations.length, 2)
    f.native.save(result); await f.engine.reconcile('other-session')
    assert.equal(await f.engine.verifyPending(f.accountKey, f.web.client(), AbortSignal.timeout(1000), 'session-1', op.id), true)
    assert.equal(await f.pending(), undefined)
    assert.equal(await loggedBackendBusyRejection(f.home, { ...op, identity: { ...op.identity, responseId: 999 } }), false)
    const journal = join(f.log.contentDirectory, op.id + '.jsonl'), raw = await readFile(journal, 'utf8')
    const row = JSON.parse(raw.split('\n').find(x => x.includes('"web.event"')))
    row.payload = { name: 'update', step: 0, resume: 0, data: { v: { response: { fragments: [{ type: 'RESPONSE', content: 'output' }] } } } }
    await writeFile(journal, raw + JSON.stringify(row) + '\n', { mode: 0o600 })
    assert.equal(await loggedBackendBusyRejection(f.home, op), false)
  } finally { await f.close() }
})

test('cancelling backend-busy cooldown never submits a second generation', async () => {
  const f = await setup(), controller = new AbortController()
  try {
    const store = new LocalStore(f.home, { intervalMs: 0, cooldownMs: 300, maxCooldownMs: 300 })
    const log = { content: () => {}, write: (event, data) => {
      if (event === 'model.queued' && data.stage === 'backend-busy-cooldown') controller.abort()
    } }
    const engine = new SessionEngine({ store, storeId: 'fixture-store', native: f.native, log, maxPromptChars: 120000 })
    f.web.completion = c => reject(f, c)
    const i = input(); f.native.begin(i.sessionId)
    await assert.rejects(collect(engine.run(i, f.accountKey, f.web.client(), controller.signal, (text, id) => decodeResponse(text, [], id))))
    assert.equal(f.web.generations.length, 1)
    const op = await f.pending(); assert.equal(op.knownRejected, true)
    const gate = JSON.parse(await readFile(join(f.home, 'requests', f.accountKey + '.json'), 'utf8'))
    assert.deepEqual(gate.flights, [])
    f.native.cancel(op.native); await engine.reconcile(); assert.equal(await f.pending(), undefined)
  } finally { await f.close() }
})

test('backend busy without identity, with accepted history or after visible output never repeats a generation', async () => {
  for (const mode of ['missing-ready', 'accepted-history', 'visible-output']) {
    const f = await setup()
    try {
      f.web.completion = c => {
        if (mode === 'missing-ready') reject(f, c)
        return sse((mode === 'missing-ready' ? '' : c.ready)
          + (mode === 'visible-output' ? frame(snapshot('visible output', 'WIP')) : '') + frame(hint, 'hint'))
      }
      await assert.rejects(f.run()); assert.equal(f.web.generations.length, 1)
      assert.notEqual((await f.pending()).knownRejected, true)
    } finally { await f.close() }
  }
})

test('busy wording without an explicit service reason does not release an uncertain generation', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready }) => sse(ready + frame({ ...hint, finish_reason: 'unknown' }, 'hint'))
    await assert.rejects(f.run(), e => e.code === 'CONTENT_RETRACTED')
    assert.equal((await f.pending()).knownRejected, undefined)
  } finally { await f.close() }
})
