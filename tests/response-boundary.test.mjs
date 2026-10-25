import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeResponse, FinalDecoder, strictJson } from '../lib/core/codec.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, collect, tool, sse, frame, snapshot } from './helpers/fixture.mjs'

const final = (id, text) => `{"protocol_version":1,"request_id":${JSON.stringify(id)},"kind":"final","text":${text}}`
const options = () => ({ provider: PROVIDER, model: MODEL, sessionId: 'response-boundary', messages: [{ role: 'user', content: [{ type: 'text', text: 'Report existing verified results only. Do not repeat earlier actions.' }] }], tools: [tool] })
const adapter = f => new TokenFreeAdapter({}, { store: f.store, native: f.native, credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(f.log, c.operationId) })

test('raw string control characters normalize losslessly; strict parsing and tool schema checks remain strict', () => {
  for (let code = 0; code < 32; code++) {
    const value = `left${String.fromCharCode(code)}right\\n"中文`
    const encoded = JSON.stringify(value).replace(JSON.stringify(String.fromCharCode(code)).slice(1, -1), String.fromCharCode(code))
    const raw = final('op', encoded)
    assert.throws(() => strictJson(raw))
    let recovered = 0
    assert.equal(decodeResponse(raw, [], 'op', undefined, () => recovered++)[0].text, value)
    assert.equal(recovered, 1)
    const source = `{"kind":"tool","calls":[{"name":"read_marker","arguments":{"body":${encoded}}}]}`
    const schemaTool = { ...tool, parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] } }
    let checked = 0
    const blocks = decodeResponse(source, [schemaTool], undefined, (_, args) => { checked++; assert.equal(args.body, value) })
    assert.equal(checked, 1); assert.equal(JSON.parse(blocks[0].arguments).body, value)
    for (const stride of [1, 2, 7, raw.length]) {
      const preview = new FinalDecoder('op')
      for (let i = 0; i < raw.length; i += stride) preview.append(raw.slice(i, i + stride))
      assert.equal(preview.text, value)
    }
  }
  for (const raw of [final('op', '"line\\\ncontinuation"'), final('op', '"bad\\q"'), final('op', '"unterminated\n'), final('op', '"ok\n"') + final('op', '"other"'), '{"kind":"final","text":"a\nb","text":"c"}']) assert.throws(() => decodeResponse(raw, [], 'op'))
})

test('multiline final response completes after preview without a model retry or tool delivery', async () => {
  const f = await setup(), a = adapter(f), o = options()
  const body = 'Verified result\n\n| step | status |\r\n|---|---|\n| check | done |\n\tNo repeated actions. Literal \\n stays literal.'
  f.native.begin(o.sessionId)
  // Build raw controls without altering the intentional escaped backslash-n in the content.
  f.web.answer = p => final(p.request_id, '"' + body.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"')
  try {
    const chunks = await collect(a.stream(o))
    assert.equal(chunks.find(c => c.block?.type === 'text').block.text, body)
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), body)
    assert.equal(chunks.at(-1).type, 'finish'); assert.equal(f.web.generations.length, 1)
    assert.equal(chunks.some(c => c.blockType === 'tool-call'), false)
    const pending = await f.store.pending((await a.engine()).key(o.sessionId))
    assert.equal(pending.stage, 'awaiting-native'); assert.equal(pending.repair, undefined)
  } finally { await a.dispose(); await f.close() }
})

test('malformed final preview may be replaced once with a validated final answer, never a tool batch', async () => {
  for (const mode of ['final', 'tool', 'invalid', 'required', 'empty-preview']) {
    const f = await setup(), a = adapter(f), o = options(), chunks = []
    f.native.begin(o.sessionId)
    if (mode === 'required') await a.setPolicy(o.sessionId, { tools: { mode: 'required' }, output: { type: 'text' } })
    f.web.answer = (p, _, n) => n === 1 || mode === 'invalid'
      ? mode === 'empty-preview' ? final(p.request_id, '"\\q"') : final(p.request_id, '"provisional answer"').slice(0, -1) + ',"unexpected":true}'
      : mode === 'tool' ? { protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
        : { protocol_version: 1, request_id: p.request_id, kind: 'final', text: 'Complete verified answer' }
    try {
      if (mode === 'final' || mode === 'empty-preview') {
        chunks.push(...await collect(a.stream(o)))
        assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), mode === 'empty-preview' ? 'Complete verified answer' : 'provisional answer')
        assert.equal(chunks.find(c => c.block?.type === 'text').block.text, 'Complete verified answer')
        assert.equal(chunks.at(-1).type, 'finish')
      } else await assert.rejects(async () => { for await (const c of a.stream(o)) chunks.push(c) })
      assert.equal(f.web.generations.length, 2)
      assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
      if (mode !== 'required') {
        const feedback = JSON.parse(f.web.generations[1].prompt.split('DSH_PROTOCOL_CORRECTION_JSON:\n')[1])
        assert.equal(feedback.expected_kind, 'final')
      }
    } finally { await a.dispose(); await f.close() }
  }
})

test('control encoding composes with framing and punctuation repairs without changing tool arguments', t => {
  let cases = 0
  const declared = { ...tool, parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
  for (let code = 0; code < 32; code++) for (const controls of [1, 64]) {
    const value = 'literal \\n " <>() ' + String.fromCharCode(code).repeat(controls) + 'end'
    const encoded = '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
    const raw = `{"kind":"tool","calls":[{"name":"${tool.name}","arguments":{"command":${encoded}}}]}`
    for (const candidate of [raw, '<(' + raw + ')>', '```json\n' + raw + '\n```', raw.slice(0, -1), raw.slice(0, -1) + ',}}']) {
      assert.equal(JSON.parse(decodeResponse(candidate, [declared])[0].arguments).command, value); cases++
    }
  }
  assert.equal(cases, 320); t.diagnostic(`${cases} composed encoding/framing/punctuation cases; decoded command values unchanged`)
})

test('final preview correction retains cancellation, authentication, filtering, identity and shared rate cooldown boundaries', async () => {
  for (const scenario of ['cancel', 'auth', 'filter', 'identity', 'rate']) {
    const f = await setup(), a = adapter(f), o = options(), controller = new AbortController(), chunks = []
    o.signal = controller.signal; f.native.begin(o.sessionId)
    f.web.answer = (p, _, n) => ({ protocol_version: 1, request_id: p.request_id, kind: 'final', text: n === 1 ? 'provisional' : 'validated', ...(n === 1 ? { unexpected: true } : {}) })
    const fetch = f.web.fetch; let preparations = 0, limited = 0
    f.web.fetch = async (url, opts) => {
      if (url.endsWith('/create_pow_challenge') && ++preparations === 2) {
        if (scenario === 'cancel') { controller.abort(); throw new DOMException('cancelled', 'AbortError') }
        if (scenario === 'auth') return new Response('', { status: 401 })
      }
      if (scenario === 'rate' && preparations >= 2 && url.endsWith('/chat/completion') && !limited++) return new Response('', { status: 429 })
      return fetch(url, opts)
    }
    if (scenario === 'filter') f.web.completion = ({ ready, text }) => sse(ready + frame(snapshot(text, f.web.generations.length === 2 ? 'CONTENT_FILTER' : 'FINISHED')))
    if (scenario === 'identity') f.web.completion = ({ ready, text, assistant }) => { assistant.fragments[0].content = 'different history'; return sse(ready + frame(snapshot(text))) }
    try {
      if (scenario === 'rate') {
        chunks.push(...await collect(a.stream(o)))
        assert.equal(chunks.at(-1).type, 'finish'); assert.equal(chunks.find(c => c.block?.type === 'text').block.text, 'validated')
      } else await assert.rejects(async () => { for await (const c of a.stream(o)) chunks.push(c) }, e => e.code === ({ cancel: 'ABORTED', auth: 'AUTH', filter: 'CONTENT_RETRACTED', identity: 'WEB_IDENTITY' }[scenario]))
      assert.equal(f.web.generations.length, ['cancel', 'auth', 'identity'].includes(scenario) ? 1 : 2)
      assert.equal(chunks.some(c => c.blockType === 'tool-call'), false)
    } finally { await a.dispose(); await f.close() }
  }
})
