import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decodeResponse } from '../lib/core/codec.js'

const bash = { name: 'bash', parameters: { type: 'object', properties: {
  command: { type: 'string' }, description: { type: 'string' },
}, required: ['command'], additionalProperties: false } }
const parameter = (name, value, string = false) => `<｜｜DSML｜｜ parameter name="${name}" string="${string}">${string ? value : JSON.stringify(value)}</｜｜DSML｜｜ parameter>`
const invoke = (name, parameters) => `<｜｜DSML｜｜ invoke name="${name}">\n${parameters}\n</｜｜DSML｜｜ invoke>`
const calls = (...items) => `<｜｜DSML｜｜ calls>\n${items.join('\n')}\n</｜｜DSML｜｜ calls>`
const wrapped = (name, args) => invoke(name, parameter('arguments', args))
const decode = (text, tools = [bash], validate) => decodeResponse(text, tools, 'current-operation', validate)

test('DSML captured preflight shape becomes the exact native tool call without another generation', () => {
  const args = { description: 'Preflight ffmpeg yt-dlp aria2c and proxy port', command: 'ffmpeg -version; yt-dlp --version' }
  let validated = 0
  const blocks = decode(calls(wrapped('bash', args)), [bash], (tool, value) => {
    assert.equal(tool, bash); assert.deepEqual(JSON.parse(JSON.stringify(value)), args); validated++
  })
  assert.equal(validated, 1)
  assert.deepEqual(blocks, [{ type: 'tool-call', id: 'tokenfree_current-operation_0', name: 'bash', arguments: JSON.stringify(args) }])
})

test('DSML named parameters preserve strings, structured JSON and a schema-declared arguments property', () => {
  const tool = { name: 'typed', parameters: { type: 'object', properties: { arguments: { type: 'object' } } } }
  const values = { command: ' echo "你好"\n<literal>&amp; ', count: 0, enabled: false, nullable: null, list: [1, 'two'] }
  const params = Object.entries(values).map(([name, value]) => parameter(name, value, typeof value === 'string')).join('\n')
  assert.deepEqual(JSON.parse(decode(calls(invoke('bash', params)))[0].arguments), values)
  assert.deepEqual(JSON.parse(decode(calls(wrapped('typed', { key: 'value' })), [tool])[0].arguments), { arguments: { key: 'value' } })
})

test('DSML complete batches keep ordering and reject the whole response on any unknown tool or ninth call', () => {
  const one = wrapped('bash', { command: 'echo one' })
  const two = wrapped('bash', { command: 'echo two' })
  assert.deepEqual(decode(calls(one, two)).map(x => JSON.parse(x.arguments).command), ['echo one', 'echo two'])
  for (const text of [calls(one, wrapped('unknown', {})), calls(...Array(9).fill(one))]) {
    assert.throws(() => decode(text), error => error.code === 'WEB_TOOL_FORMAT' && ['syntax', 'tool'].includes(error.stage))
  }
})

test('DSML rejects mixed prose, truncation, duplicate parameters and duplicate JSON keys', () => {
  const valid = calls(wrapped('bash', { command: 'echo ok' }))
  const duplicateJson = parameter('arguments', {}).replace('{}', '{"command":"one","command":"two"}')
  for (const text of [
    'Example: ' + valid, valid + '\nextra', valid.slice(0, -1), calls(),
    calls(invoke('bash', '')), calls(invoke('bash', parameter('command', 'one', true) + parameter('command', 'two', true))),
    calls(invoke('bash', duplicateJson)),
    valid.replace('string="false"', 'string="maybe"'),
    valid.replace('name="bash"', 'name="bash" extra="yes"'),
    calls(invoke('bash', parameter('arguments', 'not an object'))),
  ]) assert.throws(() => decode(text), error => error.code === 'WEB_TOOL_FORMAT' && ['syntax', 'tool'].includes(error.stage))
})

test('DSML does not bypass parameter validation, tool availability, or literal final JSON text', () => {
  const text = calls(wrapped('bash', { command: 42 }))
  assert.throws(() => decode(text, [bash], () => { throw new Error('invalid command type') }), /invalid command type/)
  assert.throws(() => decode(text, []), error => error.code === 'WEB_TOOL_FORMAT')
  const final = JSON.stringify({ protocol_version: 1, request_id: 'current-operation', kind: 'final', text })
  assert.deepEqual(decode(final), [{ type: 'text', text }])
})

test('retired legacy codec recovery payload retains its immutable manifest hash', () => {
  const manifest = JSON.parse(readFileSync(new URL('../maintenance/legacy-compat/manifest.json', import.meta.url)))
  const rule = manifest.files['lib/core/codec.js']
  const payload = readFileSync(new URL(`../maintenance/legacy-compat/payload/${rule.payload}`, import.meta.url))
  assert.ok(payload.toString().includes('function dsmlEnvelope'))
  assert.equal(createHash('sha256').update(payload).digest('hex'), rule.sha256)
  assert.ok(rule.acceptedHashes.includes(rule.sha256))
  assert.equal(rule.allowMissing, false)
})
