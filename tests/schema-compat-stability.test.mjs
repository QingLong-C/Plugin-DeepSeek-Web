import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { sanitizeJsonSchema } from '../lib/dsh/schema-sanitize.js'
import { StrictSchemas } from '../lib/dsh/strict-schema.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/index.js'
import { setup, collect, tool } from './helpers/fixture.mjs'

const event = { type: 'object', oneOf: ['input', 'signal'].map(kind => ({
  type: 'object', properties: { kind: { type: 'string', const: kind }, at: { type: 'integer', minimum: 0 } },
  required: ['kind', 'at'], additionalProperties: false,
})) }
const schema = { type: 'object', properties: { events: { type: 'array', items: event } }, required: ['events'], additionalProperties: false }

test('redundant union type projects to the host without changing the original strict constraints', () => {
  const before = structuredClone(schema), projected = sanitizeJsonSchema(schema), strict = new StrictSchemas()
  assert.doesNotThrow(() => assertSupportedJsonSchema(projected))
  assert.equal(projected.properties.events.items.type, undefined)
  assert.deepEqual(schema, before)
  const valid = { events: [{ kind: 'input', at: 0 }] }
  strict.check(schema, valid)
  assert.deepEqual(validateJsonSchemaValue(schema, valid), [])
  for (const value of [{ events: [{ kind: 'unknown', at: 0 }] }, { events: [{ kind: 'input', at: -1 }] },
    { events: [{ kind: 'signal', at: 0, extra: true }] }, { events: ['input'] }]) {
    assert.throws(() => strict.check(schema, value), error => error.code === 'INVALID_TOOL_CALL')
  }
})

test('a mixed or untyped branch cannot make a parent type redundant', () => {
  for (const branches of [[{ type: 'object' }, { type: 'string' }], [{ type: 'object' }, {}], []]) {
    const value = { type: 'object', oneOf: branches }
    assert.equal(sanitizeJsonSchema(value).type, 'object')
    assert.throws(() => assertSupportedJsonSchema(sanitizeJsonSchema(value)))
  }
})

test('a tool catalogue containing a redundant typed union still delivers a separate valid tool once', async () => {
  const f = await setup(), adapter = new TokenFreeAdapter({}, { store: f.store, diagnostics: f.log,
    credential: async () => ({ token: 'fixture-token', accountId: 'fixture-owner' }),
    client: (_, context) => f.web.client(f.log, context.operationId) })
  f.web.answer = request => ({ protocol_version: 1, request_id: request.request_id, kind: 'tool',
    calls: [{ name: tool.name, arguments: {} }] })
  try {
    const chunks = await collect(adapter.stream({ provider: PROVIDER, model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the marker.' }] }],
      tools: [tool, { name: 'capture_events', description: 'Record typed events.', parameters: schema }] }))
    const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].block.name, tool.name)
    assert.equal(f.web.generations.length, 1)
  } finally { await adapter.dispose(); await f.close() }
})
