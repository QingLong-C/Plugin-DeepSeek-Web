import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readWebEvents } from '../lib/deepseek-web/sse.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
import { decodeResponse } from '../lib/core/codec.js'
import { setup, input, frame, snapshot, sse, collect, tool } from './helpers/fixture.mjs'

// Same control fields as the captured failure; no account/session/task data.
const hint = { type: 'error', content: '消息发送过于频繁，请稍后重试', clear_response: true, finish_reason: 'rate_limit_reached' }

test('explicit rate-limit hints retain their cause through withdrawal and without clear_response', async () => {
  for (const clear of [true, false]) {
    const events = []
    await assert.rejects(async () => {
      for await (const event of readWebEvents(sse(frame({ ...hint, clear_response: clear }, 'hint')), 'fixture')) events.push(event)
    }, error => error.code === 'RATE_LIMIT' && /官网限流.*rate_limit_reached/.test(error.message))
    assert.equal(events.filter(e => e.type === 'event' && e.name === 'hint').length, 1)
    assert.equal(events.some(e => e.type === 'snapshot' && e.snapshot.cleared), clear)
    if (clear) assert.equal(events.find(e => e.type === 'snapshot').snapshot.clearError.code, 'RATE_LIMIT')
  }
})

test('real adapter exposes RATE_LIMIT without tools, resume or format correction', async () => {
  for (const mode of ['clear', 'keep', 'http429']) {
  const f = await setup(), chunks = []
  const adapter = new TokenFreeAdapter({}, { store: f.store, native: f.native, credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: () => f.web.client() })
  f.web.completion = ({ ready }) => mode === 'http429' ? new Response('rate limited', { status: 429 }) : sse(ready + frame({ ...hint, clear_response: mode === 'clear' }, 'hint'))
  try {
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({ provider: PROVIDER, model: MODEL, tools: [tool], messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue only the unfinished inspection.' }] }] })) chunks.push(chunk)
    }, error => error.code === 'RATE_LIMIT' && (mode === 'http429' ? /HTTP 429/.test(error.message) : /官网限流/.test(error.message)))
    assert.equal(f.web.generations.length, 1)
    assert.equal(f.web.resumes.length, 0)
    assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call' || c.type === 'finish'), false)
  } finally { await adapter.dispose(); await f.close() }
  }
})

test('rate-limit withdrawal removes displayed preview but retains the cause and never resubmits', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false)), events = []
  f.web.completion = ({ ready, text }) => sse(ready + frame(snapshot(text.slice(0, -2), 'WIP', 'preview reasoning')) + frame(hint, 'hint'))
  try {
    const i = input(); f.native.begin(i.sessionId)
    await assert.rejects(async () => {
      for await (const event of f.engine.run(i, f.accountKey, f.web.client(f.log), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))) events.push(event)
    }, error => error.code === 'RATE_LIMIT')
    assert(events.some(e => e.type === 'text'))
    assert.equal(events.filter(e => e.type === 'withdraw').length, 1)
    assert.equal(events.some(e => e.type === 'result'), false)
    assert.equal(f.web.generations.length, 1)
    assert.equal(f.web.resumes.length, 0)
    await f.log.flush()
    const files = await readdir(f.log.contentDirectory)
    assert.equal(files.length, 1)
    const rows = (await readFile(join(f.log.contentDirectory, files[0]), 'utf8')).trim().split('\n').map(JSON.parse)
    const preview = rows.findLast(r => r.event === 'preview').payload
    assert.equal(preview.text, '')
    assert.equal(rows.some(r => r.event === 'web.event' && r.payload.data?.finish_reason === 'rate_limit_reached'), true)
  } finally { await f.close() }
})

test('ordinary model text cannot masquerade as a service rate-limit control frame', async () => {
  const text = JSON.stringify(hint)
  const events = await collect(readWebEvents(sse(frame(snapshot(text))), 'fixture'))
  assert.equal(events.at(-1).snapshot.text, text)
  assert.equal(events.at(-1).snapshot.cleared, false)
})

test('unknown clear_response stays an unexplained withdrawal instead of guessing from prose', async () => {
  const f = await setup()
  f.web.completion = ({ ready }) => sse(ready + frame({ ...hint, finish_reason: 'unknown_reason' }, 'hint'))
  try { await assert.rejects(() => f.run(), e => e.code === 'CONTENT_RETRACTED' && /未提供具体原因/.test(e.message)); assert.equal(f.web.generations.length, 1) }
  finally { await f.close() }
})
