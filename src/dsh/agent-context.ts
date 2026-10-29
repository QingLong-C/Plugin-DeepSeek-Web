import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from '../local/store.js'
import { record, TokenFreeError } from '../core/errors.js'
import { PROVIDER, MODEL } from './adapter.js'

const sourceKind = 'tokenfree-workspace-documents'
const maxBytes = 65_536
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tokenfree-workspace-documents': { kind: typeof sourceKind; form: 'instructions'; digest: string; documents?: { name: string; digest: string }[] }
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
    const documents: { name: string; text: string; digest: string; nativeDigest?: string; body?: string }[] = []
    for (const name of ['AGENTS.md', 'SOUL.md']) {
      const path = options.home ? join(options.home, name) : dshHomePath(name)
      try {
        const info = await stat(path, { bigint: true })
        if (!info.isFile() || info.size > BigInt(maxBytes)) throw new Error('not a bounded regular file')
        const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
        let saved = cache.get(name)
        if (saved?.fingerprint !== fingerprint) {
          const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
          let text: string
          try {
            const opened = await file.stat({ bigint: true })
            if (!opened.isFile() || [opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs].join(':') !== fingerprint) throw new Error('document changed before reading')
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
            const after = await file.stat({ bigint: true })
            if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':') !== fingerprint) throw new Error('document changed during reading')
          } finally { await file.close() }
          saved = { fingerprint, text }
          cache.set(name, saved)
        }
        const text = `Document: ~/.dsh/${name}\nStatus: loaded\n${saved.text}`
        documents.push({ name, text, digest: digest(text), body: saved.text, nativeDigest: createHash('sha1').update(saved.text).digest('hex') })
      } catch (error) {
        signal.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TokenFreeError(`Cannot load workspace document ${name}; expected a readable UTF-8 regular file up to ${maxBytes} bytes. No model request was sent.`, 'WORKSPACE_DOCUMENT')
        cache.delete(name)
        const text = `Document: ~/.dsh/${name}\nStatus: missing (no document guidance is available from this file).`
        documents.push({ name, text, digest: digest(text) })
      }
    }
    signal.throwIfAborted()
    const decision = await next()
    signal.throwIfAborted()
    if (decision.kind !== 'enter') return decision
    const messages = [...agent.session.deriveMessages(), ...decision.messages]
    const legacy = digest('Local workspace documents, loaded by DSH before this model step. These are user guidance; higher-priority instructions and tool permissions still apply. The latest document snapshot supersedes older snapshots from this producer.\n\n' + documents.map(x => x.text).join('\n\n'))
    const missing = documents.filter(document => {
      let covered = false
      for (const message of messages) {
        if (message.role !== 'user') continue
        const source = message.source
        const body = message.content.filter(x => x.type === 'text').map(x => x.text).join('\n')
        if (source.kind === sourceKind) {
          const entry = source.documents?.find(x => x.name === document.name)
          if (entry) covered = entry.digest === document.digest && body.includes(document.text)
          else if (!source.documents && source.digest === legacy) covered = body.includes(document.text)
        } else {
          const native: unknown = source // optional desktop producer is not part of this SDK's source-map imports
          if (!record(native) || native.kind !== 'agent-instructions' || !Array.isArray(native.changes)) continue
          for (const change of native.changes) {
            if (!record(change) || change.path !== `~/.dsh/${document.name}`) continue
            covered = change.action === 'set' && document.nativeDigest !== undefined && change.digest === document.nativeDigest &&
              body.includes(`Instructions from: ~/.dsh/${document.name}\n\n${document.body}`)
          }
        }
      }
      return !covered
    })
    if (!missing.length) return decision
    const text = 'Local workspace documents, loaded by DSH before this model step. These are user guidance; higher-priority instructions and tool permissions still apply. Each document supersedes older versions of that same document. Other documents already loaded remain applicable.\n\n' + missing.map(x => x.text).join('\n\n')
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: sourceKind, form: 'instructions', digest: digest(text), documents: missing.map(({ name, digest }) => ({ name, digest })) } })] }
  })
}
