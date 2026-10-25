import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

test('built client replaces only withdrawal rows, preserves native fallback and releases its slot on unload', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.test/' })
  globalThis.window = dom.window; globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react'), { render, cleanup } = await import('@testing-library/react')
  const core = new SlotCore(), disposers = [], require = createRequire(import.meta.url)
  const native = ({ node }) => React.createElement('div', null, `NATIVE:${node.data.code}:${node.data.message}`)
  core.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } }, () => null)
  const slots = {
    inject: (_key, callback) => { const dispose = callback(); disposers.push(dispose); return dispose },
    register: core.register.bind(core), entries: core.entries.bind(core), subscribe: core.subscribe.bind(core),
  }
  let client, unmounted = false
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(require) } } },
  })
  const scope = { slots, get: () => undefined, remote: { tokenfree: {} } }
  const ctx = {
    remote: { $mount: async () => async () => { unmounted = true } },
    inject: (_dependencies, callback) => {
      callback(scope)
      return { await: async () => {}, dispose: async () => { for (const dispose of disposers.reverse()) dispose() } }
    },
  }
  let unload, removeNative
  try {
    // Declaration can precede the shipped renderer: plugin load order must not lose the override.
    unload = await client.apply(ctx)
    removeNative = core.register({ name: 'conversation.chat.node', key: 'turn-error', priority: 100, locale: 'chat' }, native)
    await new Promise(resolve => queueMicrotask(resolve))
    const winner = () => core.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'turn-error')
    assert.notEqual(winner().component, native, 'TokenFree should own the display wrapper')
    const props = (code, message) => ({ node: { kind: 'turn-error', data: { code, message, turn: 2, seq: 40 } }, t: key => key })
    for (const [code, message, heading] of [
      ['RATE_LIMIT', 'DeepSeek 官网限流（rate_limit_reached）：消息发送过于频繁，请稍后重试。', '官网限流'],
      ['RATE_LIMIT', 'DeepSeek Web request failed (HTTP 429).', '官网限流'],
      ['CONTENT_RETRACTED', 'Web response did not complete (CONTENT_FILTER).', '官网内容过滤'],
      ['CONTENT_RETRACTED', 'DeepSeek 官网内容过滤（CONTENT_FILTER）：本次回答已被官网拦截或撤回。', '官网内容过滤'],
      ['CONTENT_RETRACTED', 'Web response was withdrawn.', '官网撤回了回答'],
      ['WEB_TOOL_FORMAT', 'Invalid or ambiguous DSML tool batch. No tools were executed.', '响应协议格式错误'],
      ['INVALID_TOOL_CALL', 'Strict argument schema mismatch.', '工具参数不符合规则'],
      ['INVALID_TOOL_CALL', '已自动纠正一次，参数仍不合格。', '工具参数不符合规则'],
      ['WEB_TOOL_FORMAT', '已自动纠正一次，工具协议仍不完整或不合规。', '响应协议格式错误'],
      ['INVALID_TOOL_CALL', '已自动纠正两次，参数仍不合格。', '工具参数不符合规则'],
      ['WEB_TOOL_FORMAT', '已自动纠正两次，返回协议仍不合格。', '响应协议格式错误'],
      ['OUTPUT_SCHEMA', 'Strict final output schema mismatch.', '回答格式不符合规则'],
      ['OUTPUT_FORMAT', '已自动纠正一次，输出仍不合格。', '回答格式不符合规则'],
      ['TOOL_CHOICE', '已自动纠正一次，工具选择仍不合格。', '工具选择不符合规则'],
    ]) {
      const ui = render(React.createElement(winner().component, props(code, message)))
      assert.ok(ui.getByText(heading))
      assert.ok(ui.getByText(code))
      if (message.includes('已自动纠正一次')) assert.match(ui.container.textContent, code === 'WEB_TOOL_FORMAT' ? /已自动纠正一次，回答或工具协议仍未通过校验/ : /已自动纠正一次，返回参数仍未通过规则/)
      if (message.includes('已自动纠正两次')) assert.match(ui.container.textContent, code === 'WEB_TOOL_FORMAT' ? /已自动纠正两次，回答或工具协议仍未通过校验/ : /已自动纠正两次，返回参数仍未通过规则/)
      if (code === 'RATE_LIMIT') {
        assert.match(ui.container.textContent, /稍后继续未完成步骤/)
        assert.equal(ui.container.textContent.includes('撤回'), false)
        assert.equal(ui.container.textContent.includes('内容过滤'), false)
      }
      assert.equal(ui.container.textContent.includes('本轮运行失败'), false)
      if (heading !== '官网内容过滤') assert.equal(ui.container.textContent.includes('官网内容过滤'), false)
      cleanup()
    }
    for (const [code, message] of [['AUTH', 'auth error'], ['TRANSPORT', 'CONTENT_FILTER mentioned by an unrelated error'], ['RATE_LIMIT', 'Another provider rate limit']]) {
      const ui = render(React.createElement(winner().component, props(code, message)))
      assert.equal(ui.container.textContent, `NATIVE:${code}:${message}`)
      cleanup()
    }
    await unload(); unload = undefined
    assert.equal(winner().component, native)
    assert.equal(unmounted, true)
  } finally { await unload?.(); removeNative?.(); cleanup(); dom.window.close() }
})
