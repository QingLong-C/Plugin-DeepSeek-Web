import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeInput, catalogueHash } from '../lib/core/codec.js'
import { StrictSchemas } from '../lib/dsh/strict-schema.js'
import { input, tool, payload } from './helpers/fixture.mjs'

test('each bootstrap and delta carries a bounded exact envelope contract bound to current tools and request', () => {
  const schemas = new StrictSchemas()
  for (const mode of ['auto', 'none', 'required', 'named']) {
    for (const bootstrap of [true, false]) {
      const i = input([], 'session', mode === 'none' ? [] : [tool])
      i.policy = { tools: mode === 'named' ? { mode, name: tool.name } : { mode }, output: { type: 'text' } }
      const p = payload(encodeInput(i, 'request-fixture', bootstrap ? 0 : 1, [], bootstrap, 100_000, bootstrap))
      assert.equal(p.response_contract.enforcement, 'local-validation')
      assert.equal(p.response_contract.tool_catalogue_version, catalogueHash(i.tools))
      const schema = p.response_contract.envelope_schema
      const final = { protocol_version: 1, request_id: 'request-fixture', kind: 'final', text: 'ok' }
      const call = { protocol_version: 1, request_id: 'request-fixture', kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
      if (mode === 'auto' || mode === 'none') schemas.check(schema, final)
      else assert.throws(() => schemas.check(schema, final))
      if (mode !== 'none') schemas.check(schema, call)
      else assert.throws(() => schemas.check(schema, call))
      for (const bad of [{ ...final, request_id: 'old' }, { ...final, extra: true }, { ...call, calls: [] }, { ...call, calls: Array(9).fill(call.calls[0]) },
        { ...call, calls: [{ name: 'unavailable', arguments: {} }] }, { ...call, calls: [{ name: tool.name, arguments: '{}' }] }]) assert.throws(() => schemas.check(schema, bad))
    }
  }
})
