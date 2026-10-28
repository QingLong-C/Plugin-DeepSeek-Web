import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TokenFreeError, record } from '../core/errors.js'
import { acquireLock } from './lock.js'
import { readJson, writeJson } from './files.js'
import type { ActiveOperation } from './store.js'

export interface RequestPolicy { intervalMs: number; cooldownMs: number; maxCooldownMs: number }
export const defaultRequestPolicy: Readonly<RequestPolicy> = Object.freeze({ intervalMs: 10_000, cooldownMs: 60_000, maxCooldownMs: 900_000 })
export type GenerationFlight = Pick<ActiveOperation, 'id' | 'sessionKey' | 'chatId' | 'parentId' | 'promptHash' | 'fileIds' | 'parentPath' | 'compaction' | 'identity' | 'rateRejected'>
interface State { version: 1; next: number; until: number; strikes: number; flights?: GenerationFlight[] }
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const path = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(p => record(p) && integer(p.id) && (p.parentId === null || integer(p.parentId)) && hash(p.hash))
function validFlight(v: unknown): v is GenerationFlight {
  return record(v) && typeof v.id === 'string' && v.id.length > 0 && hash(v.sessionKey) && typeof v.chatId === 'string' && v.chatId.length > 0
    && hash(v.promptHash) && (v.parentId === null || integer(v.parentId))
    && (v.fileIds === undefined || Array.isArray(v.fileIds) && v.fileIds.every(id => typeof id === 'string' && /^file-[A-Za-z0-9_-]{1,128}$/.test(id)) && new Set(v.fileIds).size === v.fileIds.length)
    && (v.parentId === null ? v.parentPath === undefined : path(v.parentPath))
    && (v.compaction === undefined || record(v.compaction) && integer(v.compaction.rootId) && integer(v.compaction.oldParentId) && path(v.compaction.oldPath))
    && (v.rateRejected === undefined || typeof v.rateRejected === 'boolean')
    && (v.identity === undefined || record(v.identity) && v.identity.chatId === v.chatId && integer(v.identity.requestId) && integer(v.identity.responseId))
}
export interface RequestLease {
  flights(): readonly GenerationFlight[] | undefined
  initialize(flights: GenerationFlight[]): Promise<void>
  started(flight: GenerationFlight): Promise<void>
  finished(id: string): Promise<void>
  wait(signal: AbortSignal): Promise<void>
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
        || !['next', 'until', 'strikes'].every(k => Number.isSafeInteger(saved[k]) && Number(saved[k]) >= 0)
        || saved.flights !== undefined && (!Array.isArray(saved.flights) || !saved.flights.every(validFlight)
          || new Set(saved.flights.map(f => f.id)).size !== saved.flights.length))) {
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
        flights: () => { check(); return state.flights === undefined ? undefined : structuredClone(state.flights) },
        initialize: async flights => {
          check()
          if (state.flights !== undefined || !flights.every(validFlight) || new Set(flights.map(f => f.id)).size !== flights.length) throw new TokenFreeError('Invalid generation fence initialization.', 'STATE_STORAGE')
          state.flights = structuredClone(flights); await writeJson(this.path, state)
        },
        started: async flight => {
          check()
          if (!validFlight(flight) || state.flights === undefined || state.flights.some(f => f.id !== flight.id)) throw new TokenFreeError('An unconfirmed Web generation still owns this account.', 'PENDING_OPERATION')
          state.flights = [structuredClone(flight)]; await writeJson(this.path, state)
        },
        finished: async id => { check(); if (state.flights?.some(f => f.id === id)) { state.flights = state.flights.filter(f => f.id !== id); await writeJson(this.path, state) } },
        wait: async active => { check(); await wait(Math.max(state.next, state.until), active) },
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
