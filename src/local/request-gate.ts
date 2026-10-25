import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TokenFreeError, record } from '../core/errors.js'
import { acquireLock } from './lock.js'
import { readJson, writeJson } from './files.js'

export interface RequestPolicy { intervalMs: number; cooldownMs: number; maxCooldownMs: number }
export const defaultRequestPolicy: Readonly<RequestPolicy> = Object.freeze({ intervalMs: 10_000, cooldownMs: 60_000, maxCooldownMs: 900_000 })
interface State { version: 1; next: number; until: number; strikes: number }
export interface RequestLease {
  submission(signal: AbortSignal): Promise<void>
  failed(error: unknown): Promise<void>
  succeeded(): Promise<void>
  release(): Promise<void>
}
/** Retry-After is advisory, bounded to one day; never interpret arbitrary prose as a duration. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const text = value.trim()
  const milliseconds = /^\d+$/.test(text) ? Number(text) * 1000
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ? Date.parse(text) - now : NaN
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(milliseconds, 86_400_000) : undefined
}
/** One cross-process FIFO lease per account, independent of credentials and session journals. */
export class AccountRequestGate {
  private readonly path: string
  constructor(private readonly home: string, private readonly accountKey: string, private readonly policy: RequestPolicy = defaultRequestPolicy) {
    if (!/^[a-f0-9]{64}$/.test(accountKey) || ![policy.intervalMs, policy.cooldownMs, policy.maxCooldownMs].every(x => Number.isSafeInteger(x) && x >= 0)
      || policy.cooldownMs > policy.maxCooldownMs) throw new TokenFreeError('Invalid account request policy.', 'STATE_STORAGE')
    this.path = join(home, 'requests', accountKey + '.json')
  }
  async enter(signal: AbortSignal): Promise<RequestLease> {
    const unlock = await acquireLock(join(this.home, 'locks', 'request-' + this.accountKey), signal)
    let released = false
    try {
      const saved = await readJson<unknown>(this.path)
      if (saved !== undefined && (!record(saved) || saved.version !== 1
        || !['next', 'until', 'strikes'].every(k => Number.isSafeInteger(saved[k]) && Number(saved[k]) >= 0))) {
        throw new TokenFreeError('Account cooldown state is damaged; it was preserved.', 'STATE_STORAGE')
      }
      const state: State = saved as State | undefined ?? { version: 1, next: 0, until: 0, strikes: 0 }
      const wait = async (target: number, active: AbortSignal) => {
        while (target > Date.now()) await delay(Math.min(target - Date.now(), 1000), undefined, { signal: active })
        active.throwIfAborted()
      }
      // Queue and persisted cooldown do not consume the subsequently started generation timeout.
      await wait(Math.max(state.next, state.until), signal)
      const check = () => { if (released) throw new TokenFreeError('Account lease was released.', 'STATE_STORAGE') }
      return {
        submission: async active => { check(); await wait(Math.max(state.next, state.until), active); state.next = Date.now() + this.policy.intervalMs; await writeJson(this.path, state) },
        failed: async error => {
          check()
          if (!(error instanceof TokenFreeError) || error.code !== 'RATE_LIMIT') return
          state.strikes = Math.min(state.strikes + 1, 32)
          const backoff = Math.min(this.policy.maxCooldownMs, this.policy.cooldownMs * 2 ** (state.strikes - 1))
          const hint = error.details?.retryAfterMs
          state.until = Math.max(state.until, Date.now() + backoff, Date.now() + (Number.isFinite(hint) && hint! >= 0 ? Math.min(hint!, 86_400_000) : 0))
          await writeJson(this.path, state)
        },
        succeeded: async () => { check(); state.strikes = 0; state.until = 0; await writeJson(this.path, state) },
        release: async () => { if (!released) { released = true; await unlock() } },
      }
    } catch (error) { await unlock(); throw error }
  }
}
