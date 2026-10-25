import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeResponse, strictJson } from '../lib/core/codec.js'

const tool = { name: 'bash', parameters: { type: 'object' } }
const args = { description: 'Check syntax and executable lookup', command: 'printf \'brace } comma , quote "\\n\'\n# 保留原命令', nested: { flags: [true, false, null, 0] } }
const wrap = body => `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash"><｜｜DSML｜｜ parameter name="arguments" string="false">${body}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
const raw = JSON.stringify(args)
const cases = [
  ['redundant root closer', raw + '}'],
  ['multiple redundant root closers', raw + '}}}'],
  ['opposite redundant root closer', raw + ']'],
  ['mixed redundant root closers', raw + ']}]}'],
  ['object trailing comma', raw.slice(0, -1) + ',}'],
  ['nested array trailing comma', raw.replace('[true,false,null,0]', '[true,false,null,0,]')],
  ['missing final object closer', raw.slice(0, -1)],
  ['missing nested and root closers', raw.slice(0, -2)],
  ['whole JSON fence', '```json\n' + raw + '\n```'],
  ['combined trailing comma and redundant closer', raw.replace('[true,false,null,0]', '[true,false,null,0,]').slice(0, -1) + ',}}'],
]
for (const [label, body] of cases) test(`local tool syntax recovery: ${label} preserves every argument value`, () => {
  const blocks = decodeResponse(wrap(body), [tool], 'op')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].name, 'bash')
  assert.deepEqual(JSON.parse(blocks[0].arguments), args)
})

test('whole DSML/JSON response fences and full JSON envelopes recover without altering literal final text', () => {
  for (const fence of ['```xml\n', '```dsml\n', '```\n']) {
    assert.deepEqual(JSON.parse(decodeResponse(fence + wrap(raw + '}') + '\n```', [tool], 'op')[0].arguments), args)
  }
  const envelope = JSON.stringify({ protocol_version: 1, request_id: 'op', kind: 'tool', calls: [{ name: 'bash', arguments: args }] })
  assert.deepEqual(JSON.parse(decodeResponse('```json\n' + envelope + '}\n```', [tool], 'op')[0].arguments), args)
  const literal = 'quoted code ```json {"command":"x"}} ```'
  assert.deepEqual(decodeResponse(JSON.stringify({ protocol_version: 1, request_id: 'op', kind: 'final', text: literal }), [], 'op'), [{ type: 'text', text: literal }])
})

test('syntax recovery rejects ambiguous/incomplete values, duplicate keys, extra data and excessive repair budgets', () => {
  for (const body of [
    '{"command":"unterminated}', '{"command":}', '{"command":"one",',
    '{"command":"one","command":"two"}}', '{"nested":{"x":1,"x":2}}}',
    '{"command":"one"}{"command":"two"}', '{"nested":{"x":1],"command":"one"}',
    '{command:"one"}', "{'command':'one'}", '{"command":undefined}',
    '{"command":1,,}', '{}'+ '}'.repeat(9), '{"x":'.repeat(65)+'0',
  ]) assert.throws(() => decodeResponse(wrap(body), [tool], 'op'), error => error.code === 'WEB_TOOL_FORMAT', body)
  assert.throws(() => decodeResponse('example: ' + wrap(raw), [tool], 'op'))
  assert.throws(() => decodeResponse(wrap(raw).slice(0, -3), [tool], 'op'))
  assert.throws(() => decodeResponse(wrap(raw + '}').replace('name="bash"', 'name="missing"'), [tool], 'op'))
  assert.throws(() => decodeResponse(wrap(raw + '}'), [tool], 'op', () => { throw new Error('schema rejection') }), /schema rejection/)
  assert.throws(() => decodeResponse('{"protocol_version":1,"request_id":"other","kind":"tool","calls":[{"name":"bash","arguments":{}}]}}', [tool], 'op'), error => error.code === 'WEB_IDENTITY')
  assert.throws(() => strictJson(raw + '}'), /Trailing/)
})

test('whole batch validation still rejects a later invalid call after an earlier recovered call', () => {
  const pair = wrap(raw + '}').replace('</｜｜DSML｜｜ calls>', wrap('{"command":}').replace('<｜｜DSML｜｜ calls>', ''))
  assert.throws(() => decodeResponse(pair, [tool], 'op'), error => error.code === 'WEB_TOOL_FORMAT')
})

test('one encoded JSON arguments object is unwrapped but schema-declared string values stay literal', () => {
  for (const response of [wrap(JSON.stringify(raw)), wrap(raw).replace('string="false"', 'string="true"'),
    JSON.stringify({ protocol_version: 1, request_id: 'op', kind: 'tool', calls: [{ name: 'bash', arguments: raw }] }),
  ]) assert.deepEqual(JSON.parse(decodeResponse(response, [tool], 'op')[0].arguments), args)
  const declared = { name: 'bash', parameters: { type: 'object', properties: { arguments: { type: 'string' } } } }
  assert.deepEqual(JSON.parse(decodeResponse(wrap(raw).replace('string="false"', 'string="true"'), [declared], 'op')[0].arguments), { arguments: raw })
  assert.throws(() => decodeResponse(wrap(JSON.stringify(JSON.stringify(raw))), [tool], 'op'))
})

test('generated nested values keep punctuation, escapes and unicode across bounded syntax repairs', () => {
  for (let n = 0; n < 120; n++) {
    const value = { command: `printf ']} , \\" ${n} 中文'\n# literal \\n`, nested: [{ n, value: n % 2 ? null : false }, [n, `x${n}`]] }
    const text = JSON.stringify(value)
    for (const candidate of [text + '}', text.slice(0, -1), text.slice(0, -1) + ',}']) {
      assert.deepEqual(JSON.parse(decodeResponse(wrap(candidate), [tool], 'op')[0].arguments), value)
    }
  }
})
