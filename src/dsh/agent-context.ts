import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from '../local/store.js'
import { record, TokenFreeError } from '../core/errors.js'
import { PROVIDER, MODEL } from './adapter.js'

const sourceKind = 'tokenfree-workspace-documents'
const maxBytes = 65_536
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tokenfree-workspace-documents': { kind: typeof sourceKind; form: 'instructions'; digest: string }
  }
}

export function isWebAgent(agent: Agent): boolean {
  const events = agent.session.snapshotEvents()
  const selection = events.findLastIndex(x => String(x.type) === 'model/selection')
  const header = events.findLastIndex(x => x.type === 'request/header')
  const pending: unknown = events[selection]?.data
  const route = selection > header && record(pending) && typeof pending.provider === 'string' && typeof pending.model === 'string'
    ? pending : agent.session.requestHeader()?.config ?? agent.options
  return route.provider === PROVIDER && route.model === MODEL
}

/** Load local user guidance at the native admission boundary, never as fabricated tool results. */
export function installAgentContext(ctx: Context, options: { home?: string } = {}): void {
  const caches = new WeakMap<Agent, Map<string, { fingerprint: string; text: string }>>()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!isWebAgent(agent)) return next()
    signal.throwIfAborted()
    let cache = caches.get(agent)
    if (!cache) { cache = new Map(); caches.set(agent, cache) }
    const documents: string[] = []
    for (const name of ['AGENTS.md', 'SOUL.md']) {
      const path = options.home ? join(options.home, name) : dshHomePath(name)
      try {
        const info = await stat(path, { bigint: true })
        if (!info.isFile() || info.size > BigInt(maxBytes)) throw new Error('not a bounded regular file')
        const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
        let saved = cache.get(name)
        if (saved?.fingerprint !== fingerprint) {
          const file = await open(path, 'r')
          let text: string
          try {
            const buffer = Buffer.alloc(maxBytes + 1)
            let length = 0
            while (length < buffer.length) {
              signal.throwIfAborted()
              const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
              if (!bytesRead) break
              length += bytesRead
            }
            if (length > maxBytes) throw new Error('document exceeds limit')
            text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
          } finally { await file.close() }
          saved = { fingerprint, text }
          cache.set(name, saved)
        }
        documents.push(`Document: ~/.dsh/${name}\nStatus: loaded\n${saved.text}`)
      } catch (error) {
        signal.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TokenFreeError(`Cannot load workspace document ${name}; expected a readable UTF-8 regular file up to ${maxBytes} bytes. No model request was sent.`, 'WORKSPACE_DOCUMENT')
        cache.delete(name)
        documents.push(`Document: ~/.dsh/${name}\nStatus: missing (no document guidance is available from this file).`)
      }
    }
    signal.throwIfAborted()
    const text = 'Local workspace documents, loaded by DSH before this model step. These are user guidance; higher-priority instructions and tool permissions still apply. The latest document snapshot supersedes older snapshots from this producer.\n\n' + documents.join('\n\n')
    const version = digest(text)
    const decision = await next()
    signal.throwIfAborted()
    if (decision.kind !== 'enter') return decision
    const previous = [...agent.session.deriveMessages(), ...decision.messages].findLast(message => message.role === 'user' && message.source.kind === sourceKind)
    if (previous?.source.kind === sourceKind && previous.source.digest === version) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: sourceKind, form: 'instructions', digest: version } })] }
  })
}
