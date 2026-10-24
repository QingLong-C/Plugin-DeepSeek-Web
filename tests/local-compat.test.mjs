import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/index.js'
import { TokenFreeCompactionEngine } from '../lib/dsh/compaction.js'
import { bindRuntime } from '../lib/dsh/binding.js'
import { sanitizeJsonSchema } from '../lib/dsh/schema-sanitize.js'
import { setup, collect, tool } from './helpers/fixture.mjs'

const base = text => ({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
const adapterFor = f => new TokenFreeAdapter({}, { store: f.store, credential: async () => ({ token: 'fixture-secret-token', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(f.log, c.operationId) })

test('compatibility accepts unsupported tool annotations and keeps argument validation', async () => {
  const f = await setup(), adapter = adapterFor(f)
  const parameters = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false }
  const original = structuredClone(parameters)
  const projected = sanitizeJsonSchema(parameters)
  assert.deepEqual(parameters, original)
  assert.equal(projected.$schema, undefined)
  assert.equal(projected.properties.path.type, 'string')
  assert.equal(projected.properties.path.minLength, undefined)
  const tools = [{ ...tool, parameters }]
  f.web.answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: { path: '/fixture' } }] })
  try {
    const chunks = await collect(adapter.stream({ ...base('Read the fixture.'), tools }))
    assert.equal(chunks.find(x => x.type === 'block-end').block.name, tool.name)
    f.web.answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: { path: 123 } }] })
    await assert.rejects(collect(adapter.stream({ ...base('Read the fixture again.'), tools })))
  } finally { adapter.dispose(); await f.close() }
})

test('default adapter accepts serialized input above the old 500000-character cap', async () => {
  const f = await setup(), adapter = adapterFor(f)
  try {
    await collect(adapter.stream(base('x'.repeat(510000))))
    assert.equal(f.web.generations.length, 1)
    assert.ok(f.web.generations[0].prompt.length > 500000)
    assert.ok(f.web.generations[0].prompt.length < 2621440)
    await assert.rejects(collect(adapter.stream(base('x'.repeat(2621440)))), error => error.code === 'INPUT_TOO_LARGE')
    assert.equal(f.web.generations.length, 1, 'Oversized input must fail before generation')
  } finally { adapter.dispose(); await f.close() }
})

test('pending model selection controls compaction when switching into and away from TokenFree', async () => {
  const engine = Object.create(TokenFreeCompactionEngine.prototype)
  engine.ctx = { tokenfree: { bindingId: 'local-route-regression' } }
  engine.otherAuto = false
  let reconciled = 0
  const unbind = bindRuntime('local-route-regression', {
    async reconcile() { reconciled++ },
    async usage() { return { compaction: 'needs-new-chat' } },
  })
  const other = { provider: 'fixture-provider', model: 'fixture-model' }
  const own = { provider: PROVIDER, model: MODEL }
  let header = { config: other }
  const events = [{ type: 'request/header', seq: 1, data: {} }, { type: 'model/selection', seq: 2, data: own }]
  const agent = { id: 'route-test', options: {}, session: { requestHeader: () => header, snapshotEvents: () => events } }
  try {
    await engine.compactIfNeeded(agent, 'pressure', AbortSignal.timeout(5000))
    assert.equal(reconciled, 1)
    header = { config: own }; events[1].data = other
    await engine.compactIfNeeded(agent, 'pressure', AbortSignal.timeout(5000))
    assert.equal(reconciled, 1)
    events.push({ type: 'request/header', seq: 3, data: {} })
    await engine.compactIfNeeded(agent, 'pressure', AbortSignal.timeout(5000))
    assert.equal(reconciled, 2, 'A newer request header supersedes an older selection')
  } finally { unbind() }
})
