import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeInput, catalogueHash } from '../lib/core/codec.js'
import { StrictSchemas } from '../lib/dsh/strict-schema.js'
import { input, tool, payload } from './helpers/fixture.mjs'

test('every step advertises actual host tools independently of skills and preserves explicit no-tools policy', () => {
  for (const bootstrap of [true, false]) {
    const i = input([], 'without-a-skill', [tool])
    const prompt = encodeInput(i, 'task', bootstrap ? 0 : 1, [tool], bootstrap, 100_000, bootstrap)
    const p = payload(prompt)
    assert.deepEqual(p.agent_capabilities.tool_names, [tool.name])
    assert.equal(p.agent_capabilities.execution, 'dsh-host')
    assert.equal(p.agent_capabilities.skill_required, false)
    assert.equal(prompt.includes('discover applicable skills'), false, 'the bridge must not impose a skill-discovery workflow')
    assert.equal(prompt.includes('NO native callable tools'), false)
    assert.equal(p.response_policy.tools.mode, 'auto')
  }
  const none = input([], 'no-tools', [])
  none.policy = { tools: { mode: 'none' }, output: { type: 'text' } }
  const p = payload(encodeInput(none, 'task', 0, [], true, 100_000))
  assert.deepEqual(p.agent_capabilities.tool_names, [])
  assert.equal(p.response_policy.tools.mode, 'none')
})

test('each bootstrap and delta carries a content-only envelope contract bound to current tools', () => {
  const schemas = new StrictSchemas()
  for (const mode of ['auto', 'none', 'required', 'named']) {
    for (const bootstrap of [true, false]) {
      const i = input([], 'session', mode === 'none' ? [] : [tool])
      i.policy = { tools: mode === 'named' ? { mode, name: tool.name } : { mode }, output: { type: 'text' } }
      const p = payload(encodeInput(i, 'request-fixture', bootstrap ? 0 : 1, [], bootstrap, 100_000, bootstrap))
      assert.equal(p.response_contract.enforcement, 'local-validation')
      assert.equal(p.response_contract.tool_catalogue_version, catalogueHash(i.tools))
      const schema = p.response_contract.envelope_schema
      const final = { kind: 'final', text: 'ok' }
      const call = { kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
      if (mode === 'auto' || mode === 'none') schemas.check(schema, final)
      else assert.throws(() => schemas.check(schema, final))
      if (mode !== 'none') schemas.check(schema, call)
      else assert.throws(() => schemas.check(schema, call))
      for (const bad of [{ ...final, request_id: 'old' }, { ...final, extra: true }, { ...call, calls: [] }, { ...call, calls: Array(9).fill(call.calls[0]) },
        { ...call, calls: [{ name: 'unavailable', arguments: {} }] }, { ...call, calls: [{ name: tool.name, arguments: '{}' }] }]) assert.throws(() => schemas.check(schema, bad))
    }
  }
})
