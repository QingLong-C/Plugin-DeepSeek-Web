import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { record } from '../core/errors.js'
import { digest, type ActiveOperation } from './store.js'

/** Narrow migration of old rate-limit journals. Prose, previews and error labels are not evidence. */
export async function loggedRateRejection(home: string, operation: ActiveOperation): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/.test(operation.id) || !operation.native || !operation.identity || operation.repair || operation.expected?.length) return false
  let file
  try {
    file = await open(join(home, 'logs', 'requests', operation.id + '.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 32 * 1024 * 1024) return false
    const rows: unknown[] = (await file.readFile('utf8')).trim().split('\n').map(line => JSON.parse(line))
    let native = false, submitted = false, ready = false, rejected = false
    for (const row of rows) {
      if (!record(row) || row.operationId !== operation.id || !record(row.payload)) return false
      const p = row.payload
      if (row.event === 'dsh.request') {
        if (native || !record(p.native) || ['sessionId', 'turn', 'step', 'attemptId', 'instance', 'afterSeq'].some(k => p.native && (p.native as Record<string, unknown>)[k] !== (operation.native as unknown as Record<string, unknown>)[k])) return false
        native = true
      }
      if (row.event === 'web.request' && ['/api/v0/chat/completion', '/api/v0/chat/edit_message'].includes(String(p.endpoint))) {
        if (submitted || p.endpoint !== '/api/v0/chat/completion' || !record(p.body) || p.body.chat_session_id !== operation.chatId
          || p.body.parent_message_id !== operation.parentId || digest(p.body.prompt) !== operation.promptHash) return false
        submitted = true
      }
      if (row.event !== 'web.event') continue
      if (p.step !== 0 || p.resume !== 0 || !record(p.data)) return false
      if (p.name === 'ready') {
        if (ready || !submitted || p.data.request_message_id !== operation.identity.requestId || p.data.response_message_id !== operation.identity.responseId) return false
        ready = true
      } else if (p.name === 'hint' && p.data.type === 'error' && p.data.clear_response === true && p.data.finish_reason === 'rate_limit_reached' && ready && !rejected) rejected = true
      else return false // any snapshot, patch, other control or subsequent stream remains uncertain
    }
    return native && submitted && ready && rejected
  } catch { return false } finally { await file?.close() }
}
