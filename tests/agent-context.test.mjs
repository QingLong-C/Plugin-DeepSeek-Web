import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { isWebAgent, installAgentContext } from '../lib/dsh/agent-context.js'
import { digest } from '../lib/local/store.js'
import { DshBoundary } from '../lib/dsh/native.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, payload } from './helpers/fixture.mjs'

test('native execution demand reads routing before dispatch, admits it once and restores it after compaction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-demand-')), handlers = new Map()
  installAgentContext({ on(name, callback) { handlers.set(name, callback) } }, { home })
  let effective = [], dispatched = 0
  const agent = { options: { provider: PROVIDER, model: MODEL }, session: { snapshotEvents: () => [], deriveMessages: () => effective, requestHeader: () => undefined } }
  const signal = new AbortController().signal
  const enter = () => handlers.get('agent/pre-step')({ agent, signal }, async () => ({ kind: 'enter', messages: [] }))
  const invoke = name => handlers.get('tools/pre-execute')({ agent, signal, name }, async () => { dispatched++; return { kind: 'allow' } })
  try {
    await writeFile(join(home, 'AGENTS.md'), 'Read routing on skill demand.')
    await writeFile(join(home, 'SOUL.md'), Buffer.from([0xc3, 0x28]))
    effective.push(...(await enter()).messages)
    assert.equal(effective.length, 1, 'greeting must not read invalid SOUL')
    await assert.rejects(() => invoke('inspect_fixture'), e => e.code === 'WORKSPACE_DOCUMENT')
    assert.equal(dispatched, 0, 'unreadable demanded routing must fail before tool dispatch')
    await writeFile(join(home, 'SOUL.md'), '| task | skill |\n| inspect | fixture |')
    await Promise.all([invoke('inspect_fixture'), invoke('inspect_fixture')])
    assert.equal(dispatched, 2, 'parallel native calls remain unchanged and share routing demand')
    const routed = await enter()
    assert.deepEqual(routed.messages[0].source.documents.map(x => x.name), ['SOUL.md'])
    effective.push(...routed.messages)
    await invoke('skill')
    assert.equal((await enter()).messages.length, 0, 'do not repeat full routing in a valid context')
    effective = []
    assert.deepEqual((await enter()).messages[0].source.documents.map(x => x.name), ['AGENTS.md', 'SOUL.md'])
    agent.options.provider = 'other'
    await writeFile(join(home, 'SOUL.md'), Buffer.from([0xc3, 0x28]))
    await invoke('skill')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('native sessions preload only AGENTS; SOUL is task-owned and changes do not trigger injection', async () => {
  const f = await setup(), ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-rules-'))
  let adapter
  try {
    await writeFile(join(home, 'AGENTS.md'), 'Project convention: keep {{literal}} unchanged.\n')
    await writeFile(join(home, 'SOUL.md'), '| task | skill |\n| unrelated task | unrelated |\n')
    for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SessionProjectionRegistry, ToolRuntime, SystemPrompt]) await ctx.plugin(plugin)
    ctx.on('session/flush', async () => {})
    let native
    await ctx.plugin({ name: 'agent-context-native', inject: ['llm', 'sessions'], apply(scope) {
      native = new DshBoundary(scope, attempt => adapter?.reconcile(attempt))
      installAgentContext(scope, { home })
    } })
    adapter = new TokenFreeAdapter({ sessionStoreId: 'agent-context-fixture' }, { store: f.store, native,
      credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(c.diagnostics, c.operationId) })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('agent-context-session'), { provider: PROVIDER, model: MODEL })
    const ask = async text => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle(); await adapter.reconcile()
    }
    await ask('Explain the current project convention.')
    const first = payload(f.web.generations[0].prompt)
    const source = first.messages.flatMap(m => m.content).map(c => c.text ?? '').join('\n')
    assert.ok(source.includes('keep {{literal}} unchanged.'))
    assert.equal(source.includes('| unrelated task | unrelated |'), false)
    assert.equal(source.includes('Document: ~/.dsh/SOUL.md'), false)
    const contexts = () => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'tokenfree-workspace-documents')
    assert.equal(contexts().length, 1)
    await ask('Continue with a normal answer.')
    assert.equal(contexts().length, 1)
    assert.equal(payload(f.web.generations[1].prompt).mode, 'delta')
    await writeFile(join(home, 'SOUL.md'), 'Updated routing document.\n')
    await ask('Check the current convention again.')
    assert.equal(contexts().length, 1)
    assert.equal(f.web.generations[2].prompt.includes('Updated routing document.'), false)
    await writeFile(join(home, 'AGENTS.md'), 'Updated project convention.\n')
    await ask('Check the changed convention.')
    assert.equal(contexts().length, 2)
    assert.ok(f.web.generations[3].prompt.includes('Updated project convention.'))
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'tool/call').length, 0, 'file preloading must not invent model tool calls')
  } finally { await adapter?.dispose(); await ctx.fiber.dispose(); await f.close(); await rm(home, { recursive: true, force: true }) }
})

test('document loader leaves other providers alone and reports unreadable documents before generation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-rules-error-'))
  const handlers = new Map()
  const ctx = { on(name, callback) { handlers.set(name, callback) } }
  try {
    installAgentContext(ctx, { home })
    const handler = handlers.get('agent/pre-step')
    const agent = { options: { provider: 'other', model: MODEL }, session: { snapshotEvents: () => [], deriveMessages: () => [], requestHeader: () => undefined } }
    const result = { kind: 'enter', messages: [] }
    const request = { agent, messages: [], signal: new AbortController().signal }
    assert.equal(await handler(request, async () => result), result)
    agent.options.provider = PROVIDER
    const missing = await handler(request, async () => result)
    assert.equal(missing.messages.length, 1)
    assert.ok(missing.messages[0].content[0].text.includes('missing'))
    await writeFile(join(home, 'AGENTS.md'), 'A valid global entry.\n')
    await writeFile(join(home, 'SOUL.md'), Buffer.from([0xc3, 0x28]))
    const valid = await handler(request, async () => result)
    assert.deepEqual(valid.messages[0].source.documents.map(x => x.name), ['AGENTS.md'], 'invalid optional routing must not be read or block admission')
    await writeFile(join(home, 'AGENTS.md'), 'x'.repeat(65537))
    await assert.rejects(() => handler(request, async () => result), e => e.code === 'WORKSPACE_DOCUMENT')
    const abort = new AbortController(); abort.abort()
    await assert.rejects(() => handler({ ...request, signal: abort.signal }, async () => result))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('native tools execute and return real results with no skill tool or matching route, including subsequent delta steps', async () => {
  const f = await setup(), ctx = new Context()
  let adapter, runs = 0
  try {
    await writeFile(join(f.home, 'AGENTS.md'), 'Use local conventions, then solve with existing tools.\n')
    await writeFile(join(f.home, 'SOUL.md'), '| unrelated task | unrelated-skill |\n')
    for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SessionProjectionRegistry, ToolRuntime, SystemPrompt]) await ctx.plugin(plugin)
    ctx.on('session/flush', async () => {})
    const native = new DshBoundary(ctx, attempt => adapter?.reconcile(attempt))
    installAgentContext(ctx, { home: f.home })
    ctx.tools.register(defineTool({ name: 'inspect_fixture', description: 'Inspect a local fixture.', parameters: {},
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      execute: async () => { runs++; return 'verified-fixture-result' } }))
    adapter = new TokenFreeAdapter({ sessionStoreId: 'no-skill-native' }, { store: f.store, native,
      credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(c.diagnostics, c.operationId) })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    f.web.answer = p => p.messages.some(m => m.role === 'tool') ? { kind: 'final', text: 'verified-fixture-result' }
      : { kind: 'tool', calls: [{ name: 'inspect_fixture', arguments: {} }] }
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('no-skill-native'), { provider: PROVIDER, model: MODEL })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the local fixture.' }], source: { kind: 'user' } }))
    await agent.whenIdle(); await adapter.reconcile()
    const events = agent.session.snapshotEvents()
    assert.equal(runs, 1)
    assert.equal(events.filter(e => e.type === 'tool/call').length, 1)
    assert.equal(events.filter(e => e.type === 'tool/result').length, 1)
    assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
    const second = payload(f.web.generations[1].prompt)
    assert.equal(second.mode, 'delta')
    assert.deepEqual(second.agent_capabilities.tool_names, ['inspect_fixture'])
    assert.equal(second.agent_capabilities.skill_required, false)
    assert.equal(f.web.generations[0].prompt.includes('| unrelated task | unrelated-skill |'), false)
    assert.equal(f.web.generations[1].prompt.includes('| unrelated task | unrelated-skill |'), true, 'direct tools must also demand routing without requiring a matching skill')
  } finally { await adapter?.dispose(); await ctx.fiber.dispose(); await f.close() }
})

test('native skill dispatch admits demanded routing alongside the unchanged real skill result', async () => {
  const f = await setup(), ctx = new Context()
  let adapter, runs = 0
  try {
    await writeFile(join(f.home, 'AGENTS.md'), 'Use routing when selecting a skill.')
    await writeFile(join(f.home, 'SOUL.md'), '| fixture task | fixture skill |')
    for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SessionProjectionRegistry, ToolRuntime, SystemPrompt]) await ctx.plugin(plugin)
    ctx.on('session/flush', async () => {})
    const native = new DshBoundary(ctx, attempt => adapter?.reconcile(attempt))
    installAgentContext(ctx, { home: f.home })
    ctx.tools.register(defineTool({ name: 'skill', description: 'Read the requested skill.', parameters: {},
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      execute: async () => { runs++; return 'real-skill-body' } }))
    adapter = new TokenFreeAdapter({ sessionStoreId: 'routing-demand-native' }, { store: f.store, native,
      credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(c.diagnostics, c.operationId) })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    f.web.answer = p => p.messages.some(m => m.role === 'tool') ? { kind: 'final', text: 'done' }
      : { kind: 'tool', calls: [{ name: 'skill', arguments: {} }] }
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('routing-demand-native'), { provider: PROVIDER, model: MODEL })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the fixture skill.' }], source: { kind: 'user' } }))
    await agent.whenIdle(); await adapter.reconcile()
    assert.equal(runs, 1)
    assert.equal(f.web.generations[0].prompt.includes('| fixture task | fixture skill |'), false)
    assert.equal(f.web.generations[1].prompt.includes('| fixture task | fixture skill |'), true)
    assert.equal(f.web.generations[1].prompt.includes('real-skill-body'), true)
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(e => e.type === 'tool/call').length, 1)
    assert.equal(events.filter(e => e.type === 'tool/result').length, 1)
    assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed')
  } finally { await adapter?.dispose(); await ctx.fiber.dispose(); await f.close() }
})


test('pending model selection determines document admission before a request header exists', () => {
  const events = []
  const agent = { options: { provider: 'other', model: MODEL }, session: { snapshotEvents: () => events, requestHeader: () => undefined } }
  assert.equal(isWebAgent(agent), false)
  events.push({ type: 'model/selection', data: { provider: PROVIDER, model: MODEL } })
  assert.equal(isWebAgent(agent), true)
  events.push({ type: 'model/selection', data: { provider: 'other', model: 'other' } })
  assert.equal(isWebAgent(agent), false)
})

test('reuse native AGENTS without loading SOUL; restore AGENTS after compaction and refresh changes or removal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-native-rules-'))
  let handler
  installAgentContext({ on(_, callback) { handler = callback } }, { home })
  const instructions = 'Keep the full native convention.\n'
  const host = createUserMessage({ content: [{ type: 'text', text: `Instructions from: ~/.dsh/AGENTS.md\n\n${instructions}` }],
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set', path: '~/.dsh/AGENTS.md', scope: 'user-global\0AGENTS.md', digest: createHash('sha1').update(instructions).digest('hex') }] } })
  let effective = []
  const agent = { options: { provider: PROVIDER, model: MODEL }, session: { snapshotEvents: () => [], deriveMessages: () => effective, requestHeader: () => undefined } }
  const request = { agent, signal: new AbortController().signal }
  const enter = messages => handler(request, async () => ({ kind: 'enter', messages }))
  try {
    await writeFile(join(home, 'entry.md'), instructions)
    await symlink(join(home, 'entry.md'), join(home, 'AGENTS.md'))
    await writeFile(join(home, 'route.md'), 'Routing body.\n')
    await symlink(join(home, 'route.md'), join(home, 'SOUL.md'))
    const first = await enter([host]) // host middleware may inject in this same admission decision
    assert.equal(first.messages.length, 1, 'reuse native AGENTS and do not preload routing')
    assert.equal(first.messages[0], host)
    effective.push(...first.messages)
    assert.equal((await enter([])).messages.length, 0)
    effective = [] // compaction discarded AGENTS
    const restored = await enter([])
    assert.ok(restored.messages[0].content[0].text.includes(instructions))
    assert.equal(restored.messages[0].content[0].text.includes('Routing body.'), false)
    effective.push(...restored.messages)
    await writeFile(join(home, 'AGENTS.md'), 'Updated convention.\n')
    const updated = await enter([])
    assert.ok(updated.messages[0].content[0].text.includes('Updated convention.'))
    effective.push(...updated.messages)
    await rm(join(home, 'AGENTS.md'))
    const missing = await enter([])
    assert.ok(missing.messages[0].content[0].text.includes('Status: missing'))
    effective.push(...missing.messages)
    assert.equal((await enter([])).messages.length, 0)
    assert.deepEqual(await handler(request, async () => ({ kind: 'idle' })), { kind: 'idle' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a native metadata digest without its full body cannot suppress document loading', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-partial-rules-'))
  let handler
  installAgentContext({ on(_, callback) { handler = callback } }, { home })
  const text = 'Complete convention with retained tail.\n'
  const host = createUserMessage({ content: [{ type: 'text', text: 'Truncated convention.' }], source: { kind: 'agent-instructions', form: 'instructions',
    changes: [{ action: 'set', path: '~/.dsh/AGENTS.md', digest: createHash('sha1').update(text).digest('hex') }] } })
  const agent = { options: { provider: PROVIDER, model: MODEL }, session: { snapshotEvents: () => [], deriveMessages: () => [host], requestHeader: () => undefined } }
  try {
    await writeFile(join(home, 'AGENTS.md'), text)
    const result = await handler({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.ok(result.messages[0].content[0].text.includes(text))
    await writeFile(join(home, 'AGENTS.md'), Buffer.from([0xc3, 0x28]))
    await assert.rejects(() => handler({ agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] })), e => e.code === 'WORKSPACE_DOCUMENT')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('unchanged legacy snapshots remain usable after upgrade; cancellation after downstream admission sends nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-legacy-rules-'))
  let handler
  installAgentContext({ on(_, callback) { handler = callback } }, { home })
  const text = 'Local workspace documents, loaded by DSH before this model step. These are user guidance; higher-priority instructions and tool permissions still apply. The latest document snapshot supersedes older snapshots from this producer.\n\n' +
    'Document: ~/.dsh/AGENTS.md\nStatus: loaded\n\n\nDocument: ~/.dsh/SOUL.md\nStatus: loaded\n'
  const legacy = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'tokenfree-workspace-documents', form: 'instructions', digest: digest(text) } })
  const agent = { options: { provider: PROVIDER, model: MODEL }, session: { snapshotEvents: () => [], deriveMessages: () => [legacy], requestHeader: () => undefined } }
  try {
    for (const name of ['AGENTS.md', 'SOUL.md']) await writeFile(join(home, name), '')
    const request = { agent, signal: new AbortController().signal }
    assert.equal((await handler(request, async () => ({ kind: 'enter', messages: [] }))).messages.length, 0)
    const abort = new AbortController()
    await assert.rejects(() => handler({ agent, signal: abort.signal }, async () => { abort.abort(); return { kind: 'enter', messages: [] } }))
  } finally { await rm(home, { recursive: true, force: true }) }
})
