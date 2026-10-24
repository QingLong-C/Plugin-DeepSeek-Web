import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

type Props = ChatNodeViewProps<'turn-error'>

/** Explain only TokenFree withdrawal errors; other rows retain their shipped renderer. */
export function FailureNotice({ fallback: Fallback, ...props }: Props & { fallback: ComponentType<Props> }) {
  const { code, message } = props.node.data
  if (code !== 'CONTENT_RETRACTED') return <Fallback {...props} />
  // Older persisted errors already carry the explicit upstream status in their message.
  const filtered = /\bCONTENT_FILTER\b/.test(message)
  const title = filtered ? '官网内容过滤' : '官网撤回了回答'
  const explanation = filtered
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
