import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { decodeResponse } from '../lib/core/codec.js'
import { RecoveryMemory } from '../lib/local/recovery-memory.js'
import { setup, collect, tool, frame, snapshot, sse } from './helpers/fixture.mjs'

const options = () => ({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the marker once.' }] }], tools: [tool] })
const adapter = f => new TokenFreeAdapter({}, { store: f.store, native: f.native, credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(f.log, c.operationId) })
const answer = (id, calls = [{ name: tool.name, arguments: {} }]) => ({ protocol_version: 1, request_id: id, kind: 'tool', calls })

test('a verified response with a mistyped request echo gets one frozen correction before native delivery', async () => {
  const f = await setup(), a = adapter(f), chunks = []
  let raw
  f.web.answer = (p, _, n) => n === 1 ? (raw = answer(p.request_id.replace(/.$/, c => c === 'a' ? 'b' : 'a'))) : answer(p.request_id)
  try {
    chunks.push(...await collect(a.stream(options())))
    assert.equal(f.web.generations.length, 2)
    const correction = f.web.generations[1]
    assert.equal(correction.parent_message_id, 2)
    assert(correction.prompt.includes('FORMAT_REPAIR'))
    assert.deepEqual(JSON.parse(correction.prompt.split('CANDIDATE_JSON:\n')[1]), raw)
    assert.equal(chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 1)
    assert.equal(chunks.find(c => c.block?.type === 'tool-call').block.name, tool.name)
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    const entries = (await new RecoveryMemory(f.home).all()).flatMap(x => x.entries)
    assert(entries.some(x => x.stage === 'wrapper' && x.status === 'resolved' && x.solutions['response-wrapper'] === 1))
  } finally { await a.dispose(); await f.close() }
})

test('echo correction cannot change original tool arguments or loop on another wrong echo', async () => {
  for (const mode of ['changed', 'echo']) {
    const f = await setup(), a = adapter(f), chunks = []
    const declared = { name: 'inspect', description: 'Inspect a marker', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
    f.web.answer = (p, _, n) => answer(mode === 'echo' || n === 1 ? 'mistyped' : p.request_id, [{ name: 'inspect', arguments: { path: mode === 'changed' && n > 1 ? 'changed' : 'original' } }])
    try {
      await assert.rejects(async () => { for await (const c of a.stream({ ...options(), tools: [declared] })) chunks.push(c) }, e => e.code === 'WEB_TOOL_FORMAT')
      assert.equal(f.web.generations.length, 2)
      assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
    } finally { await a.dispose(); await f.close() }
  }
})

test('echo recovery keeps malformed or invalid original batches and unknown versions terminal', async () => {
  for (const mode of ['version', 'schema', 'syntax']) {
    const f = await setup(), a = adapter(f), chunks = []
    f.web.answer = p => mode === 'version' ? { ...answer(p.request_id), protocol_version: 2 }
      : mode === 'schema' ? answer('mistyped', [{ name: tool.name, arguments: { unexpected: true } }])
      : JSON.stringify(answer('mistyped')) + '}'
    try {
      await assert.rejects(async () => { for await (const c of a.stream(options())) chunks.push(c) }, e => e.code === 'WEB_IDENTITY')
      assert.equal(f.web.generations.length, 1)
      assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
    } finally { await a.dispose(); await f.close() }
  }
})

test('a real history mismatch cannot enter echo correction', async () => {
  const f = await setup(), a = adapter(f)
  f.web.answer = () => answer('mistyped')
  f.web.completion = ({ ready, text, assistant }) => { assistant.fragments[0].content = 'different official history'; return sse(ready + frame(snapshot(text))) }
  try {
    await assert.rejects(collect(a.stream(options())), e => e.code === 'WEB_IDENTITY')
    assert.equal(f.web.generations.length, 1)
  } finally { await a.dispose(); await f.close() }
})

test('standalone decoding never silently rewrites an explicit request echo', () => {
  assert.throws(() => decodeResponse(JSON.stringify(answer('mistyped')), [tool], 'authoritative'), e => e.code === 'WEB_IDENTITY')
})

test('verified final echo correction preserves the answer and cannot promote it to tools', async () => {
  for (const changed of [false, true]) {
    const f = await setup(), a = adapter(f), chunks = []
    f.web.answer = (p, _, n) => n > 1 && changed ? answer(p.request_id)
      : { protocol_version: 1, request_id: n === 1 ? 'mistyped' : p.request_id, kind: 'final', text: 'marker answer' }
    try {
      if (changed) await assert.rejects(async () => { for await (const c of a.stream(options())) chunks.push(c) }, e => e.code === 'WEB_TOOL_FORMAT')
      else {
        chunks.push(...await collect(a.stream(options())))
        assert.equal(chunks.find(c => c.type === 'block-end' && c.block.type === 'text').block.text, 'marker answer')
      }
      assert.equal(f.web.generations.length, 2)
      assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
    } finally { await a.dispose(); await f.close() }
  }
})
