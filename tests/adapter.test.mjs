import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { MessageId } from '@deepseek-ai/dsh-llm'
import { TokenFreeAdapter, PROVIDER, MODEL, apply } from '../lib/dsh/index.js'
import { setup, collect, tool, payload, frame, snapshot, sse } from './helpers/fixture.mjs'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
const base = () => ({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the marker and answer.' }] }] })
const adapterFor = f => new TokenFreeAdapter({}, { store: f.store, diagnostics: f.log, credential: async () => ({ token: 'fixture-secret-token', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(f.log, c.operationId) })

test('strict original schemas reject the whole batch before any native tool is delivered', async () => {
  const f = await setup(), adapter = adapterFor(f), chunks = []
  const constrained = { ...tool, parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 2 } }, required: ['count'], additionalProperties: false } }
  f.web.answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [
    { name: tool.name, arguments: { count: 2 } }, { name: tool.name, arguments: { count: 1 } }] })
  try {
    await assert.rejects(async () => { for await (const c of adapter.stream({ ...base(), tools: [constrained] })) chunks.push(c) }, e => e.code === 'INVALID_TOOL_CALL')
    assert.equal(chunks.some(c => c.blockType === 'tool-call' || c.block?.type === 'tool-call'), false)
    assert.equal(f.web.generations.length, 2, 'one bounded correction; still no invalid calls')
  } finally { await adapter.dispose(); await f.close() }
})

test('unsupported original schemas fail before credentials or web generation', async () => {
  const f = await setup()
  let credentials = 0
  const adapter = new TokenFreeAdapter({}, { store: f.store, credential: async () => { credentials++; return { token: 'fixture', accountId: 'fixture' } } })
  try {
    await assert.rejects(() => collect(adapter.stream({ ...base(), tools: [{ ...tool, parameters: { type: 'object', unknownConstraint: true } }] })), e => e.code === 'UNSUPPORTED_SCHEMA')
    assert.equal(credentials, 0)
    assert.equal(f.web.generations.length, 0)
  } finally { await adapter.dispose(); await f.close() }
})

test('recovered DSML arguments pass the real adapter once, retain policy/schema checks, and log no raw arguments', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false)), adapter = adapterFor(f)
  f.web.answer = () => '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_marker"><｜｜DSML｜｜ parameter name="arguments" string="false">{}}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>'
  try {
    const chunks = await collect(adapter.stream({ ...base(), tools: [tool] }))
    assert.equal(chunks.filter(x => x.type === 'block-end' && x.block.type === 'tool-call').length, 1)
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    assert.equal(f.web.generations.length, 1, 'local syntax repair must not send another generation')
    await f.log.flush()
    const rows = (await readFile(f.log.file, 'utf8')).trim().split('\n').map(JSON.parse)
    const recovered = rows.filter(x => x.event === 'model.format-repair' && x.stage === 'local-syntax')
    assert.equal(recovered.length, 1)
    assert.equal(JSON.stringify(recovered).includes('arguments'), false)
  } finally { adapter.dispose(); await f.close() }
})

test('official filtering and unexplained withdrawal have distinct readable errors without tools or format retries', async () => {
  for (const filtered of [true, false]) {
    const f = await setup(), adapter = adapterFor(f), chunks = []
    f.web.completion = ({ ready, text }) => sse(ready + frame(snapshot(text.slice(0, -2), 'WIP')) + (filtered
      ? frame({ p: 'response', o: 'BATCH', v: [{ p: 'status', v: 'CONTENT_FILTER' }, { p: 'fragments', v: [{ type: 'TEMPLATE_RESPONSE', content: 'Official refusal fixture.' }] }] })
      : frame({ clear_response: true }, 'hint')))
    try {
      await assert.rejects(async () => { for await (const chunk of adapter.stream({ ...base(), tools: [tool] })) chunks.push(chunk) }, error => {
        assert.equal(error.code, 'CONTENT_RETRACTED')
        assert.match(error.message, filtered ? /官网内容过滤.*CONTENT_FILTER/ : /官网撤回了回答.*未提供具体原因/)
        if (!filtered) assert.equal(error.message.includes('CONTENT_FILTER'), false)
        return true
      })
      assert.equal(chunks.some(chunk => chunk.type === 'finish' || chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta'), false)
      assert.equal(f.web.generations.length, 1)
    } finally { adapter.dispose(); await f.close() }
  }
})

test('actual DSH LlmRuntime completes DSML tool result exchange through mock official HTTP without format retry', async () => {
  const f = await setup(), ctx = new Context(), adapter = adapterFor(f)
  f.web.answer = (p, _, n) => n === 1 ? `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="${tool.name}"><｜｜DSML｜｜ parameter name="arguments" string="false">{}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
    : { protocol_version: 1, request_id: p.request_id, kind: 'final', text: p.messages.at(-1).content[0].text }
  try {
    await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter([PROVIDER], adapter)
    assert.equal((await ctx.llm.listModels(PROVIDER))[0].id, MODEL)
    const options = { ...base(), tools: [tool] }
    const first = await collect(ctx.llm.stream(options))
    const call = first.find(x => x.type === 'block-end').block
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const marker = `marker-${crypto.randomUUID()}`
    options.messages.push({ id: MessageId('a1'), role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: MODEL }, content: [call] },
      { id: MessageId('t1'), role: 'tool', source: { kind: 'tool', callId: call.id }, isError: false, content: [{ type: 'text', text: marker }] })
    const second = await collect(ctx.llm.stream(options))
    assert.equal(second.find(x => x.type === 'block-end').block.text, marker)
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(second.some(x => x.type === 'usage'), false)
    // Direct LlmRuntime calls without native session identity are explicitly temporary.
    assert.equal(f.web.generations.length, 2)
    assert.equal(f.web.chats.size, 2)
  } finally { adapter.dispose(); await ctx.fiber.dispose(); await f.close() }
})

test('plugin registers and unloads with no listening server', async () => {
  const ctx = new Context(), home = await mkdtemp(join(tmpdir(), 'tokenfree-plugin-'))
  try {
    await ctx.plugin(LlmRuntime)
    const plugin = ctx.plugin({ name: 'dsh-tokenfree', inject: ['llm'], apply: scope => apply(scope, { credentialFile: join(home, 'credentials.json') }) })
    await plugin; assert.ok(ctx.llm.listProviders().some(p => p.id === PROVIDER))
    await plugin.dispose(); assert.equal(ctx.llm.listProviders().some(p => p.id === PROVIDER), false)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('temporary calls share the account queue; cancelling a waiting call sends nothing', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false)), adapter = adapterFor(f)
  const started = [], finish = new Map()
  f.web.completion = async ({ ready, text, body }, options) => {
    started.push(body.chat_session_id)
    await new Promise((resolve, reject) => {
      finish.set(body.chat_session_id, resolve)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    return sse(ready + frame(snapshot(text)))
  }
  const waitStarted = async n => { const until = Date.now() + 3000; while (started.length < n) { if (Date.now() > until) throw new Error('calls were serialized'); await new Promise(r => setTimeout(r, 5)) } }
  const cancelled = new AbortController()
  try {
    const first = collect(adapter.stream(base()))
    await waitStarted(1)
    const second = collect(adapter.stream({ ...base(), signal: cancelled.signal }))
    const rejected = assert.rejects(second, error => error.code === 'ABORTED')
    await new Promise(r => setTimeout(r, 40))
    assert.equal(started.length, 1)
    cancelled.abort(); await rejected
    assert.equal(f.web.generations.length, 1)
    finish.get(started[0])(); await first
    assert.equal(f.web.stops.length, 0)
    await f.log.flush()
    const failures = (await readFile(f.log.file, 'utf8')).trim().split('\n').map(JSON.parse).filter(x => x.event === 'model.failed')
    assert.equal(failures.at(-1).code, 'ABORTED')
  } finally { for (const resolve of finish.values()) resolve(); await adapter.dispose(); await f.close() }
})

test('malformed JSON, unknown tool, duplicate field or invalid schema never emits executable blocks', async () => {
  for (const candidate of ['broken JSON', '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_marker"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_marker"><｜｜DSML｜｜ parameter name="arguments" string="false">{"unexpected":true}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', '{"kind":"tool","calls":[{"name":"unregistered","arguments":{}}]}', '{"kind":"final","kind":"tool","calls":[]}', '{"kind":"tool","calls":[{"name":"read_marker","arguments":{"unexpected":true}}]}']) {
    const f = await setup(), adapter = adapterFor(f); f.web.answer = () => candidate
    try {
      const chunks = []
      await assert.rejects(async () => { for await (const chunk of adapter.stream({ ...base(), tools: [tool] })) chunks.push(chunk) })
      assert.equal(chunks.some(x => x.blockType === 'tool-call' || x.type === 'tool-call-delta'), false)
      assert.equal(f.web.generations.length, 2, candidate)
    } finally { adapter.dispose(); await f.close() }
  }
})

test('complete existing intent missing protocol metadata normalizes without another generation', async () => {
  const f = await setup(), adapter = adapterFor(f)
  f.web.answer = (p, _, n) => n === 1 ? { kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
    : { protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
  try {
    const chunks = await collect(adapter.stream({ ...base(), tools: [tool] }))
    assert.equal(f.web.generations.length, 1)
    assert.equal(chunks.find(x => x.type === 'block-end').block.name, tool.name)
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  } finally { adapter.dispose(); await f.close() }
})

test('local syntax and metadata normalization compose without changing tool intent', async () => {
  const f = await setup(), adapter = adapterFor(f)
  f.web.answer = (p, _, n) => n === 1 ? '{"kind":"tool","calls":[{"name":"read_marker","arguments":{}}]}}'
    : { protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
  try {
    const chunks = await collect(adapter.stream({ ...base(), tools: [tool] }))
    assert.equal(f.web.generations.length, 1)
    assert.equal(chunks.filter(x => x.type === 'block-end' && x.block.type === 'tool-call').length, 1)
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  } finally { adapter.dispose(); await f.close() }
})

test('recovered punctuation cannot bypass schema validation or expose a partial tool batch', async () => {
  const f = await setup(), adapter = adapterFor(f), chunks = []
  f.web.answer = () => '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_marker"><｜｜DSML｜｜ parameter name="arguments" string="false">{"unexpected":true}}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>'
  try {
    await assert.rejects(async () => { for await (const c of adapter.stream({ ...base(), tools: [tool] })) chunks.push(c) }, e => e.code === 'INVALID_TOOL_CALL')
    assert.equal(chunks.some(x => x.blockType === 'tool-call' || x.type === 'tool-call-delta'), false)
    assert.equal(f.web.generations.length, 2)
  } finally { adapter.dispose(); await f.close() }
})

test('response protocol identity mismatch is never repaired into tools', async () => {
  const f = await setup(), adapter = adapterFor(f)
  f.web.answer = () => ({ protocol_version: 1, request_id: 'different-operation', kind: 'tool', calls: [{ name: tool.name, arguments: {} }] })
  try { await assert.rejects(collect(adapter.stream({ ...base(), tools: [tool] })), error => error.code === 'WEB_IDENTITY'); assert.equal(f.web.generations.length, 1) }
  finally { adapter.dispose(); await f.close() }
})

test('preflight refuses unsupported routes, native association and pending compaction without Web calls', async () => {
  const f = await setup(), adapter = adapterFor(f)
  try {
    for (const extra of [{ model: 'unknown' }, { temperature: 0.5 }, { purpose: 'compaction' }, { sessionId: 'unassociated' }]) await assert.rejects(collect(adapter.stream({ ...base(), ...extra })))
    assert.equal(f.web.requests.length, 0)
    const model = await adapter.resolveModel(PROVIDER, MODEL)
    assert.equal(model.contextWindow, undefined); assert.equal(model.reasoning.defaultEffort, 'web-on')
    await collect(adapter.stream({ ...base(), tools: [{ ...tool, name: 'web_search' }] }))
    assert.deepEqual(payload(f.web.generations[0].prompt).tools, [])
    assert.equal(f.web.generations[0].thinking_enabled, true); assert.equal(f.web.generations[0].search_enabled, false)
  } finally { adapter.dispose(); await f.close() }
})

test('missing Web credential never uses an existing paid API key', async () => {
  const f = await setup(), adapter = new TokenFreeAdapter({ credentialFile: join(f.home, 'missing.json') }, { store: f.store })
  const oldWeb = process.env.DEEPSEEK_WEB_TOKEN, oldApi = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_WEB_TOKEN; process.env.DEEPSEEK_API_KEY = 'fixture-paid-key'
  try { await assert.rejects(collect(adapter.stream(base())), error => error.code === 'MISSING_CREDENTIAL') }
  finally {
    oldWeb === undefined ? delete process.env.DEEPSEEK_WEB_TOKEN : process.env.DEEPSEEK_WEB_TOKEN = oldWeb
    oldApi === undefined ? delete process.env.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY = oldApi
    adapter.dispose(); await f.close()
  }
})

test('account wait is cancellable and does not consume the subsequent generation timeout',async()=>{
 const f=await setup(),adapter=new TokenFreeAdapter({timeoutMs:1000},{store:f.store,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:()=>f.web.client()})
 const lease=await f.store.requestGate(f.accountKey).enter(AbortSignal.timeout(4000))
 try{
  const result=collect(adapter.stream(base()))
  await new Promise(r=>setTimeout(r,1150));assert.equal(f.web.generations.length,0)
  await lease.release();const chunks=await result;assert.equal(chunks.at(-1).type,'finish');assert.equal(f.web.generations.length,1)
 }finally{await lease.release();await adapter.dispose();await f.close()}
})

test('renamed provider and model labels retain existing routing identifiers', async () => {
  const f = await setup(), adapter = adapterFor(f)
  try {
    assert.deepEqual(adapter.providerInfo(PROVIDER), { id: 'tokenfree-deepseek-web', name: 'DeepSeek Web' })
    assert.equal(PROVIDER, 'tokenfree-deepseek-web')
    assert.equal(MODEL, 'web-default')
    const models = await adapter.listModels(PROVIDER)
    assert.equal(models[0].name, 'DeepSeek Web')
    assert.equal(models[0].id, MODEL)
  } finally { await adapter.dispose(); await f.close() }
})
