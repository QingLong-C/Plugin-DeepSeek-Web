import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

type Props = ChatNodeViewProps<'turn-error'>

/** Explain TokenFree rate-limit/withdrawal/format errors; other rows retain their shipped renderer. */
export function FailureNotice({ fallback: Fallback, ...props }: Props & { fallback: ComponentType<Props> }) {
  const { code, message } = props.node.data
  const limited = code === 'RATE_LIMIT' && /^DeepSeek (?:官网限流|Web request failed \(HTTP 429\))/.test(message)
  if (!limited && !['CONTENT_RETRACTED', 'WEB_TOOL_FORMAT', 'INVALID_TOOL_CALL', 'OUTPUT_SCHEMA', 'OUTPUT_FORMAT', 'TOOL_CHOICE'].includes(code ?? '')) return <Fallback {...props} />
  // Older persisted errors already carry the explicit upstream status in their message.
  const filtered = /\bCONTENT_FILTER\b/.test(message)
  const schema = ['INVALID_TOOL_CALL', 'OUTPUT_SCHEMA', 'OUTPUT_FORMAT', 'TOOL_CHOICE'].includes(code ?? '')
  const format = code === 'WEB_TOOL_FORMAT'
  const corrected = /已自动纠正(?:一次|两次)/.test(message)
  const count = /已自动纠正两次/.test(message) ? '两次' : '一次'
  const title = limited ? '官网限流' : schema ? code === 'OUTPUT_SCHEMA' || code === 'OUTPUT_FORMAT' ? '回答格式不符合规则' : code === 'TOOL_CHOICE' ? '工具选择不符合规则' : '工具参数不符合规则' : format ? '响应协议格式错误' : filtered ? '官网内容过滤' : '官网撤回了回答'
  const explanation = limited ? 'DeepSeek 官网暂时限制了请求频率或并发，请稍后继续未完成步骤；此前完成的操作不会自动回滚。' : schema ? corrected ? `已自动纠正${count}，返回参数仍未通过规则，本步骤未执行工具；之前的操作不会自动回滚。` : '返回结果未通过声明的格式规则，本步骤未执行工具；之前的操作不会自动回滚。' : format ? corrected ? `已自动纠正${count}，回答或工具协议仍未通过校验，本步骤未派发工具；之前的操作不会自动回滚。` : '回答或工具协议不完整或存在歧义，本步骤未派发工具；之前的操作不会自动回滚。' : filtered
    ? 'DeepSeek 官网拦截或撤回了本次回答。'
    : 'DeepSeek 官网撤回了本次回答，未提供具体原因。'
  return <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 'var(--dsh-content-font-size-secondary, 13px)', overflowWrap: 'anywhere' }}>
    <span style={{ flex: 1 }}><strong style={{ color: 'var(--dsw-alias-state-warn-primary)', marginRight: 6 }}>{title}</strong><span>{explanation}</span></span>
    <code title={message} style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{code}</code>
  </div>
}

/** Shadow one public keyed slot and delegate to its live native occupant for all other errors. */
export function installFailureNotice(ctx: Context): () => void {
  const slots = ctx.slots, key = 'conversation.chat.node'
  return slots.inject(key, () => {
    let previous: StoredEntry | undefined
    let release = () => {}
    const View = (props: Props) => {
      if (!previous) return null
      return <FailureNotice {...props} fallback={previous.component as ComponentType<Props>} />
    }
    const refresh = () => {
      const candidate = slots.entries(key)
        .filter(entry => entry.options.key === 'turn-error' && entry.component !== View)
        .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
      if (candidate === previous) return
      release(); release = () => {}; previous = undefined
      // A changed host/third-party component with extra seats must keep its own wiring.
      if (!candidate || candidate.locale !== 'chat' || candidate.inject || candidate.children || candidate.store) return
      previous = candidate
      release = slots.register({ name: key, key: 'turn-error', priority: (candidate.options.priority ?? 0) - 1, locale: 'chat' }, View)
    }
    const unsubscribe = slots.subscribe(key, refresh)
    refresh()
    return () => { unsubscribe(); release(); previous = undefined }
  })
}
