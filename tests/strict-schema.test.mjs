import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StrictSchemas } from '../lib/dsh/strict-schema.js'

test('original tool schema enforces constraints omitted by host compatibility projection', () => {
  const schemas = new StrictSchemas()
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    required: ['name', 'count', 'tags'], properties: { name: { type: 'string', minLength: 3, maxLength: 8, pattern: '^[a-z]+$' },
      count: { type: 'integer', minimum: 1, maximum: 4 }, tags: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } },
      note: { type: 'string', default: 'keep optional' } } }
  const valid = { name: 'marker', count: 2, tags: ['ok'] }
  const before = structuredClone(valid)
  schemas.check(schema, valid)
  assert.deepEqual(valid, before, 'no default insertion or argument mutation')
  for (const change of [{ name: 'a' }, { name: 'toolongname' }, { name: 'Aaa' }, { count: '2' }, { count: 0 }, { count: 5 }, { tags: [] }, { tags: ['x', 'x'] }, { extra: true }]) {
    assert.throws(() => schemas.check(schema, { ...valid, ...change }), e => e.code === 'INVALID_TOOL_CALL')
  }
})

test('draft 7/2019/2020 references, combinations, conditionals, typed extra fields and formats stay enforced', () => {
  const schemas = new StrictSchemas()
  for (const $schema of [undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    const schema = { ...($schema ? { $schema } : {}), type: 'object', definitions: { positive: { type: 'integer', exclusiveMinimum: 0 } },
      required: ['count', 'mode', 'email'], properties: { count: { $ref: '#/definitions/positive' }, mode: { enum: ['read', 'write'] }, email: { type: 'string', format: 'email' } },
      additionalProperties: { type: 'string' }, allOf: [{ if: { properties: { mode: { const: 'write' } } }, then: { required: ['path'] } }],
      anyOf: [{ properties: { count: { maximum: 3 } } }, { required: ['path'] }] }
    schemas.check(schema, { count: 1, mode: 'read', email: 'test@example.org' })
    for (const value of [{ count: 0, mode: 'read', email: 'test@example.org' }, { count: 1, mode: 'write', email: 'test@example.org' },
      { count: 5, mode: 'read', email: 'test@example.org' }, { count: 1, mode: 'read', email: 'invalid' }, { count: 1, mode: 'read', email: 'test@example.org', extra: 2 }]) {
      assert.throws(() => schemas.check(schema, value), e => e.code === 'INVALID_TOOL_CALL')
    }
  }
})

test('unknown schemas fail closed without remote fetch, asynchronous validation or leaking argument values', () => {
  const schemas = new StrictSchemas()
  for (const schema of [{ type: 'object', inventedConstraint: true }, { $schema: 'https://example.org/unknown' }, { $ref: 'https://example.org/remote' },
    { $async: true, type: 'object' }, { type: 'string', format: 'invented-format' }]) {
    assert.throws(() => schemas.prepare(schema), e => e.code === 'UNSUPPORTED_SCHEMA')
  }
  assert.throws(() => schemas.check({ type: 'string', pattern: '^ok$' }, 'private-value'), e => e.code === 'INVALID_TOOL_CALL' && !e.message.includes('private-value'))
})

test('strict validation preserves allowed extra fields and evicts compilation caches without changing semantics', () => {
  const schemas = new StrictSchemas(), schema = { type: 'object', properties: { optional: { type: 'string' } } }
  const value = { extra: 2 }
  schemas.check(schema, value)
  assert.deepEqual(value, { extra: 2 })
  const first = schemas.prepare(schema)
  assert.equal(schemas.prepare(schema), first)
  for (let n = 0; n < 514; n++) schemas.check({ type: 'integer', const: n }, n)
  assert.notEqual(schemas.prepare(schema), first)
  schemas.check(schema, value)
  assert.throws(() => schemas.check({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1))
})
