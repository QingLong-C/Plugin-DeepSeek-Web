import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { decodeResponse, encodeInput, FinalDecoder } from '../lib/core/codec.js'
import { SessionEngine } from '../lib/core/session.js'
import { LocalStore } from '../lib/local/store.js'
import { setup, collect, input, payload, tool, frame, snapshot, sse } from './helpers/fixture.mjs'

const options = () => ({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the marker once.' }] }], tools: [tool] })
const adapter = f => new TokenFreeAdapter({}, { store: f.store, native: f.native, credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(f.log, c.operationId) })
const body = { kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }

test('bootstrap and delta require only content, never model-authored routing identifiers', () => {
  for (const bootstrap of [true, false]) {
    const prompt = encodeInput(input([], 'session', [tool]), 'host-operation', bootstrap ? 0 : 1, [], bootstrap, 100000, bootstrap)
    const contract = payload(prompt).response_contract.envelope_schema
    for (const shape of contract.oneOf) {
      assert(!shape.required.includes('request_id'))
      assert(!shape.required.includes('protocol_version'))
    }
    assert(!prompt.includes('COPY_REQUEST_ID'))
    assert(!prompt.includes('Copy protocol_version'))
  }
})

test('missing, mistyped and stale legacy echoes cannot cause regeneration or supply native call identity', async () => {
  for (const metadata of [{}, { request_id: 'mistyped' }, { protocol_version: 1, request_id: 'previous-operation' }, { protocol_version: 1, request_id: '' }]) {
    const f = await setup(), a = adapter(f)
    f.web.answer = () => ({ ...metadata, ...body })
    try {
      const chunks = await collect(a.stream(options()))
      assert.equal(f.web.generations.length, 1)
      const call = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block
      assert.equal(call.name, tool.name)
      assert.equal(call.id, `tokenfree_${payload(f.web.generations[0].prompt).request_id}_0`)
      assert.equal(call.arguments, '{}')
    } finally { await a.dispose(); await f.close() }
  }
})

test('legacy metadata never weakens original schema or the shared correction budget', async () => {
  for (const mode of ['version', 'type', 'schema']) {
    const f = await setup(), a = adapter(f), chunks = []
    f.web.answer = () => mode === 'version' ? { ...body, protocol_version: 99 }
      : mode === 'type' ? { ...body, request_id: { nested: 'invalid' } }
      : { ...body, request_id: 'stale', calls: [{ name: tool.name, arguments: { unexpected: true } }] }
    try {
      await assert.rejects(async () => { for await (const c of a.stream(options())) chunks.push(c) })
      assert.equal(f.web.generations.length, 2)
      assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
    } finally { await a.dispose(); await f.close() }
  }
})

test('official history mismatch rejects metadata-free and stale-echo bodies before correction or tool delivery', async () => {
  for (const metadata of [{}, { protocol_version: 1, request_id: 'stale' }]) {
    const f = await setup(), a = adapter(f), chunks = []
    f.web.answer = () => ({ ...metadata, ...body })
    f.web.completion = ({ ready, text, assistant }) => { assistant.fragments[0].content = 'different official history'; return sse(ready + frame(snapshot(text))) }
    try {
      await assert.rejects(async () => { for await (const c of a.stream(options())) chunks.push(c) }, e => e.code === 'WEB_IDENTITY')
      assert.equal(f.web.generations.length, 1)
      assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
    } finally { await a.dispose(); await f.close() }
  }
})

test('metadata-free final previews remain incremental; only host identity is used for calls', () => {
  const text = 'marker\n引号"😀', source = JSON.stringify({ kind: 'final', text })
  for (const stride of [1, 3, source.length]) {
    const decoder = new FinalDecoder('host-operation')
    for (let i = 0; i < source.length; i += stride) decoder.append(source.slice(i, i + stride))
    assert.equal(decoder.text, text)
    assert(decoder.isFinal)
  }
  assert.equal(decodeResponse(JSON.stringify({ ...body, request_id: 'untrusted' }), [tool], 'host-operation')[0].id, 'tokenfree_host-operation_0')
})

test('content-only parsing composes with existing lossless recovery without changing argument bytes', () => {
  const value = 'print "{ marker }"\n中文😀', declared = { name: 'inspect', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
  for (const metadata of [{}, { protocol_version: 1, request_id: 'stale' }]) {
    const raw = JSON.stringify({ ...metadata, calls: [{ name: 'inspect', command: value }] }) + '}'
    const blocks = decodeResponse(raw, [declared], 'host-operation')
    assert.equal(JSON.parse(blocks[0].arguments).command, value)
  }
})

test('cold restart and real tool-result delta reuse the verified branch with no echoed identifiers', async () => {
  const f = await setup(), i = input(undefined, 'transport-cold', [tool])
  f.web.answer = (_, __, n) => n === 1 ? { ...body, request_id: 'untrusted-stale-echo' } : { kind: 'final', text: 'marker confirmed' }
  try {
    const first = (await f.run(i)).find(e => e.type === 'result')
    assert.equal((await f.pending(i.sessionId)).stage, 'awaiting-native')
    const saved = f.native.save(first); await f.engine.reconcile()
    const call = first.blocks.find(b => b.type === 'tool-call')
    const result = { id: 'actual-result', role: 'tool', callId: call.id, isError: false, content: [{ type: 'text', text: 'real marker' }] }
    const engine = new SessionEngine({ store: new LocalStore(f.home, { intervalMs: 0, cooldownMs: 5, maxCooldownMs: 20 }), storeId: 'fixture-store', native: f.native, maxPromptChars: 120000 })
    const next = input([...i.messages, saved, result], i.sessionId, [tool]); f.native.begin(i.sessionId)
    const second = (await collect(engine.run(next, f.accountKey, f.web.client(), AbortSignal.timeout(5000), (raw, id) => decodeResponse(raw, [tool], id)))).find(e => e.type === 'result')
    assert.equal(f.web.generations.length, 2)
    assert.equal(f.web.chats.size, 1)
    assert.equal(f.web.generations[1].parent_message_id, 2)
    assert.deepEqual(payload(f.web.generations[1].prompt).messages, [result])
    f.native.save(second); await engine.reconcile()
    assert.equal(await f.pending(i.sessionId), undefined)
    assert.equal(second.blocks.find(b => b.type === 'text').text, 'marker confirmed')
  } finally { await f.close() }
})

test('legacy echo mutations and independent grammar decorations preserve host binding and all scalar values', t => {
  const declared = { name: 'inspect', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }
  let count = 0
  for (let seed = 0; seed < 128; seed++) {
    const command = `marker ${seed} \"{]}\"\\\n中文😀`, id = `host-${seed}`
    const legacy = seed % 2 ? { protocol_version: 1, request_id: `untrusted-${seed}` } : {}
    const envelope = JSON.stringify({ ...legacy, kind: 'tool', calls: [{ name: 'inspect', arguments: { command } }] })
    for (const raw of [envelope, JSON.stringify(envelope), `\`\`\`json\n${envelope}\n\`\`\``, envelope + '}]']) {
      const blocks = decodeResponse(raw, [declared], id)
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].id, `tokenfree_${id}_0`)
      assert.equal(JSON.parse(blocks[0].arguments).command, command)
      count++
    }
  }
  t.diagnostic(`${count} content/binding composition cases`)
})
