import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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
import { DshBoundary } from '../lib/dsh/native.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, payload } from './helpers/fixture.mjs'

test('native new sessions load literal workspace documents before generation, once per effective context; changes refresh without model tool calls', async () => {
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
    assert.ok(source.includes('| unrelated task | unrelated |'))
    const contexts = () => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'tokenfree-workspace-documents')
    assert.equal(contexts().length, 1)
    await ask('Continue with a normal answer.')
    assert.equal(contexts().length, 1)
    assert.equal(payload(f.web.generations[1].prompt).mode, 'delta')
    await writeFile(join(home, 'SOUL.md'), 'Updated routing document.\n')
    await ask('Check the current convention again.')
    assert.equal(contexts().length, 2)
    assert.ok(f.web.generations[2].prompt.includes('Updated routing document.'))
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
