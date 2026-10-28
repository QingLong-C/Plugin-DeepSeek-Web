import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireLock } from '../lib/local/lock.js'
import { writeJson } from '../lib/local/files.js'
import { LocalStore } from '../lib/local/store.js'
import { SessionEngine } from '../lib/core/session.js'
import { decodeResponse, encodeInput } from '../lib/core/codec.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, input, user, frame, snapshot, sse, collect } from './helpers/fixture.mjs'

const result = events => events.find(x => x.type === 'result')

for (const legacy of [false, true]) test(`unconfirmed website generation blocks another session across restart (legacy=${legacy})`, async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text, assistant }) => { assistant.status = 'WIP'; return sse(ready + frame(snapshot(text.slice(0, -2), 'WIP'))) }
    const i = input(undefined, 'A'); f.native.begin('A')
    const stream = f.engine.run(i, f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value.type, 'text')
    f.web.stopping = () => { throw new Error('stop outcome unknown') }
    f.web.historyHook = () => { throw new Error('history unavailable') }
    await stream.return()
    assert.equal((await f.pending('A')).stage, 'uncertain')
    if (legacy) {
      const file = join(f.home, 'requests', f.accountKey + '.json')
      const state = JSON.parse(await readFile(file, 'utf8'))
      delete state.flights
      await writeJson(file, state)
    }
    const restarted = new SessionEngine({ store: new LocalStore(f.home, { intervalMs: 0, cooldownMs: 0, maxCooldownMs: 0 }), storeId: 'other-store', native: f.native, maxPromptChars: 120000 })
    const next = () => { f.native.begin('B'); return (async () => { const events = []; for await (const e of restarted.run(input(undefined, 'B'), f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))) events.push(e); return events })() }
    await assert.rejects(next(), e => e.code === 'PENDING_OPERATION')
    assert.equal(f.web.generations.length, 1)
    f.web.historyHook = undefined
    await assert.rejects(next(), e => e.code === 'PENDING_OPERATION')
    assert.equal(f.web.generations.length, 1)
    f.web.chats.get('chat-1').find(x => x.role === 'ASSISTANT').status = 'FINISHED'
    f.web.completion = undefined
    assert.ok(result(await next()))
    assert.equal(f.web.generations.length, 2)
    assert.equal(f.web.stops.length, 1, 'admission never stops or replays the other session')
    assert.equal((await f.pending('A')).stage, 'uncertain', 'native settlement remains owned by A')
  } finally { await f.close() }
})

test('the durable account witness survives loss of its session journal', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text, assistant }) => { assistant.status = 'WIP'; return sse(ready + frame(snapshot(text.slice(0, -2), 'WIP'))) }
    f.native.begin('A')
    const stream = f.engine.run(input(undefined, 'A'), f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    await stream.next()
    f.web.stopping = () => { throw new Error('unknown stop') }
    await stream.return()
    await rm(join(f.home, 'sessions', f.engine.key('A') + '.json'))
    await assert.rejects(f.run(input(undefined, 'B')), e => e.code === 'PENDING_OPERATION')
    assert.equal(f.web.generations.length, 1)
  } finally { await f.close() }
})

test('schema dialects accepted at admission also accept their valid arguments at delivery', async () => {
  const f = await setup(), adapter = new TokenFreeAdapter({}, { store: f.store, credential: async () => ({ token: 'fixture-token', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(undefined, c.operationId) })
  const tool = { name: 'record_value', description: 'Record a nullable number.', parameters: { type: 'object', properties: { value: { type: ['number', 'null'], minimum: 2 } }, required: ['value'], additionalProperties: false } }
  f.web.answer = () => ({ kind: 'tool', calls: [{ name: tool.name, arguments: { value: 3 } }] })
  try {
    const chunks = await collect(adapter.stream({ provider: PROVIDER, model: MODEL, messages: [user('record 3')], tools: [tool] }))
    assert.equal(chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 1)
    assert.equal(f.web.generations.length, 1, 'valid arguments must not consume futile model corrections')
    f.web.answer = () => ({ kind: 'tool', calls: [{ name: tool.name, arguments: { value: 1 } }] })
    await assert.rejects(collect(adapter.stream({ provider: PROVIDER, model: MODEL, messages: [user('record 1')], tools: [tool] })), e => e.code === 'INVALID_TOOL_CALL')
  } finally { await adapter.dispose(); await f.close() }
})

test('observed official character limit bounds normal deltas before submission', async () => {
  const f = await setup()
  try {
    f.web.modelType = 'default'
    f.web.models = [{ model_type: 'default', input_character_limit: 20000, file_feature: { token_limit: 100000, token_limit_with_thinking: 100000 } }]
    const firstInput = input(), first = result(await f.run(firstInput))
    const assistant = f.native.save(first); await f.engine.reconcile('session-1')
    f.web.models[0].input_character_limit = 1000
    await assert.rejects(f.run(input([...firstInput.messages, assistant, user('x'.repeat(2000))])), e => e.code === 'INPUT_TOO_LARGE')
    assert.equal(f.web.generations.length, 1)
  } finally { await f.close() }
})

test('fresh official character limit also bounds correction prompts before another generation', async () => {
  const f = await setup()
  try {
    const i = input(), limit = encodeInput(i, randomUUID(), 0, [], true, 120000).length + 10
    f.web.modelType = 'default'
    f.web.models = [{ model_type: 'default', input_character_limit: limit, file_feature: { token_limit_with_thinking: 100000 } }]
    f.web.answer = () => 'malformed response'
    await assert.rejects(f.run(i), e => e.code === 'INPUT_TOO_LARGE')
    assert.equal(f.web.generations.length, 1)
    const pending = await f.pending()
    assert.equal(pending.finalStatus, 'FINISHED')
    assert.equal(pending.rebase, true)
  } finally { await f.close() }
})

test('strict output combinations are not reinterpreted by a weaker host schema dialect', async () => {
  const f = await setup(), adapter = new TokenFreeAdapter({}, { store: f.store, native: f.native,
    credential: async () => ({ token: 'fixture-token', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(undefined, c.operationId) })
  const policy = { tools: { mode: 'none' }, output: { type: 'schema', schema: { type: 'object', properties: { value: { oneOf: [{ type: 'number', maximum: 0 }, { type: 'number', minimum: 1 }] } }, required: ['value'], additionalProperties: false } } }
  try {
    for (const [id, value] of [['valid', 3], ['invalid', 0.5]]) {
      await adapter.setPolicy(id, policy); f.native.begin(id)
      f.web.answer = () => ({ kind: 'final', text: JSON.stringify({ value }) })
      const run = () => collect(adapter.stream({ provider: PROVIDER, model: MODEL, sessionId: id, messages: [user('return the value')] }))
      if (id === 'valid') {
        const chunks = await run()
        assert.deepEqual(JSON.parse(chunks.find(c => c.type === 'block-end' && c.block.type === 'text').block.text), { value })
        assert.equal(f.web.generations.length, 1)
      } else await assert.rejects(run(), e => e.code === 'OUTPUT_SCHEMA')
    }
  } finally { await adapter.dispose(); await f.close() }
})

for (const [field, value] of [['knownRejected', 'true'], ['rebase', []], ['stopRequested', 1], ['finalStatus', false], ['expected', [null]], ['reasoning', {}]]) {
  test(`persisted operation rejects malformed ${field} without erasing the journal`, async () => {
    const f = await setup()
    try {
      const first = result(await f.run()), key = first.operation.sessionKey, file = join(f.home, 'sessions', key + '.json')
      const state = JSON.parse(await readFile(file, 'utf8')); state.active[field] = value
      await writeJson(file, state)
      const before = await readFile(file, 'utf8')
      await assert.rejects(f.engine.reconcile('session-1'), e => e.code === 'STATE_STORAGE')
      assert.equal(await readFile(file, 'utf8'), before)
    } finally { await f.close() }
  })
}

for (const value of [null, false, 0, '', []]) test(`invalid lock ticket ${JSON.stringify(value)} cannot disappear through truthiness`, async () => {
  const f = await setup()
  try {
    const directory = join(f.home, 'locks', 'damaged'), file = join(directory, randomUUID() + '.json')
    await writeJson(file, value)
    let release
    try { await assert.rejects(async () => { release = await acquireLock(directory, AbortSignal.timeout(1000)) }, e => e.code === 'STATE_STORAGE') }
    finally { await release?.() }
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(value) + '\n')
  } finally { await f.close() }
})
