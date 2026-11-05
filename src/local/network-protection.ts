import { join } from 'node:path'
import { TokenFreeError, record } from '../core/errors.js'
import { defaultHome } from './auth.js'
import { readJson, writeJson } from './files.js'
import { acquireLock } from './lock.js'
import { retryAfterMs } from './request-gate.js'

/** Local ceilings, not service limits or a promise against account restrictions. */
export interface NetworkPolicy { http10m: number; httpDay: number; generation10m: number; generationDay: number }
export const defaultNetworkPolicy: Readonly<NetworkPolicy> = Object.freeze({ http10m: 100, httpDay: 500, generation10m: 20, generationDay: 100 })
export type NetworkMode = 'normal' | 'login-only'
type PauseReason = 'manual' | 'budget' | 'rate-limit' | 'quota' | 'challenge' | 'server-wait' | 'server-busy'
export interface ProtectionStatus { mode: NetworkMode; paused: boolean; reason?: PauseReason; since?: number; until: number; policy: NetworkPolicy; http10m: number; httpDay: number; generation10m: number; generationDay: number }
interface State { version: 1; mode?: NetworkMode; paused?: { reason: PauseReason; at: number }; until: number; policy: NetworkPolicy; requests: { at: number; generation: boolean }[] }
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const reasons: PauseReason[] = ['manual', 'budget', 'rate-limit', 'quota', 'challenge', 'server-wait', 'server-busy']
function validPolicy(v: unknown): v is NetworkPolicy {
  return record(v) && Object.keys(v).length === 4 && ['http10m', 'httpDay', 'generation10m', 'generationDay'].every(k => integer(v[k]) && Number(v[k]) > 0 && Number(v[k]) <= 50_000)
    && Number(v.http10m) <= Number(v.httpDay) && Number(v.generation10m) <= Number(v.generationDay)
    && Number(v.generation10m) <= Number(v.http10m) && Number(v.generationDay) <= Number(v.httpDay)
}
const blocked = (state: State, now: number, login = false) => {
  if (state.paused) throw new TokenFreeError('DeepSeek Web 网络已暂停；确认限制解除后由账号所有者手动恢复。', 'ACCOUNT_PAUSED', { accepted: false })
  if (state.mode === 'login-only' && !login) throw new TokenFreeError('当前仅允许手动登录，聊天及后台查询已暂停。', 'ACCOUNT_LOGIN_ONLY', { accepted: false })
  if (state.until > now) throw new TokenFreeError('官网要求的等待时间尚未结束。', 'ACCOUNT_COOLDOWN', { accepted: false, retryAfterMs: state.until - now })
}
/** One plugin-home ledger covers login and every HTTP path across instances/processes.
 * Login/logout, credential epochs and successful requests never reset it. */
export class NetworkProtection {
  readonly home: string
  constructor(home = defaultHome(), private readonly now: () => number = Date.now) { this.home = home }
  private async state(): Promise<State> {
    const saved = await readJson<unknown>(join(this.home, 'network-protection.json'))
    if (saved === undefined) return { version: 1, until: 0, policy: { ...defaultNetworkPolicy }, requests: [] }
    if (!record(saved) || saved.version !== 1 || saved.mode !== undefined && !['normal', 'login-only'].includes(String(saved.mode)) || !integer(saved.until) || !validPolicy(saved.policy)
      || saved.paused !== undefined && (!record(saved.paused) || !reasons.includes(saved.paused.reason as PauseReason) || !integer(saved.paused.at))
      || !Array.isArray(saved.requests) || saved.requests.length > 50_000 || !saved.requests.every(r => record(r) && integer(r.at) && typeof r.generation === 'boolean')) {
      throw new TokenFreeError('网络保护记录损坏，已保留原文件并阻止请求。', 'STATE_STORAGE', { accepted: false })
    }
    return saved as unknown as State
  }
  private async locked<T>(fn: (state: State) => Promise<T>, signal = AbortSignal.timeout(15_000)): Promise<T> {
    const release = await acquireLock(join(this.home, 'locks', 'network-protection'), signal)
    try { signal.throwIfAborted(); return await fn(await this.state()) } finally { await release() }
  }
  private save(state: State) { return writeJson(join(this.home, 'network-protection.json'), state) }
  private counts(state: State) {
    const now = this.now(), recent = state.requests.filter(r => r.at > now - 600_000), day = state.requests.filter(r => r.at > now - 86_400_000)
    return { http10m: recent.length, httpDay: day.length, generation10m: recent.filter(r => r.generation).length, generationDay: day.filter(r => r.generation).length }
  }
  async status(): Promise<ProtectionStatus> {
    return this.locked(async state => ({ mode: state.mode ?? 'normal', paused: Boolean(state.paused), ...(state.paused ? { reason: state.paused.reason, since: state.paused.at } : {}), until: state.until, policy: { ...state.policy }, ...this.counts(state) }))
  }
  async check(signal: AbortSignal, login = false): Promise<void> { await this.locked(async state => blocked(state, this.now(), login), signal) }
  async setMode(mode: NetworkMode, confirmed = false): Promise<void> {
    if (!['normal', 'login-only'].includes(mode)) throw new TokenFreeError('Invalid network mode.', 'INVALID_POLICY')
    if (mode === 'normal' && confirmed !== true) throw new TokenFreeError('恢复普通请求须由账号所有者明确确认。', 'ACCOUNT_LOGIN_ONLY')
    await this.locked(async state => { state.mode = mode; await this.save(state) })
  }
  async pause(): Promise<void> { await this.locked(async state => { state.paused = { reason: 'manual', at: this.now() }; await this.save(state) }) }
  async resume(confirmed: boolean): Promise<void> {
    if (confirmed !== true) throw new TokenFreeError('请先确认账号限制已解除，再手动恢复。', 'ACCOUNT_PAUSED')
    await this.locked(async state => {
      if (state.until > this.now()) throw new TokenFreeError('官网等待期限尚未结束，不能提前恢复。', 'ACCOUNT_COOLDOWN')
      delete state.paused
      // Keep rolling counts and deadlines: resume is not a budget reset.
      await this.save(state)
    })
  }
  async setPolicy(policy: NetworkPolicy): Promise<void> {
    if (!validPolicy(policy)) throw new TokenFreeError('Invalid local request budget.', 'INVALID_POLICY')
    await this.locked(async state => { state.policy = { ...policy }; await this.save(state) })
  }
  async run<T>(endpoint: string, signal: AbortSignal, send: () => Promise<T>, login = false): Promise<T> {
    // Start the send while holding the short admission lock. Once pause() commits,
    // no queued caller can start a new send. Already sent work is never replayed.
    let sent: Promise<T> | undefined
    await this.locked(async state => {
      const now = this.now()
      const loginPath = !/^\/api\/v0\/(?:chat(?:_session)?(?:\/|$)|file(?:\/|$)|client(?:\/|$))/.test(endpoint.split('?')[0] ?? '')
      blocked(state, now, login && loginPath)
      const generation = /\/chat\/(completion|edit_message)$/.test((endpoint.split('?')[0] ?? ''))
      const counts = this.counts(state)
      if (counts.http10m >= state.policy.http10m || counts.httpDay >= state.policy.httpDay
        || generation && (counts.generation10m >= state.policy.generation10m || counts.generationDay >= state.policy.generationDay)) {
        state.paused = { reason: 'budget', at: now }; await this.save(state)
        throw new TokenFreeError('已达到本机累计请求预算；网络已暂停，需人工检查。', 'REQUEST_BUDGET', { accepted: false })
      }
      state.requests = state.requests.filter(r => r.at > now - 86_400_000)
      state.requests.push({ at: now, generation }); await this.save(state)
      signal.throwIfAborted()
      sent = send()
      // Prevent a fast rejection becoming unhandled before the disk lock releases.
      void sent.catch(() => {})
    }, signal)
    return sent!
  }
  async rejected(error: unknown): Promise<void> {
    if (!(error instanceof TokenFreeError)) return
    const reason: PauseReason | undefined = error.code === 'RATE_LIMIT' ? 'rate-limit' : error.code === 'WEB_BUSY' ? 'server-busy' : error.code === 'QUOTA' ? 'quota' : error.code === 'WEB_CHALLENGE' ? 'challenge' : undefined
    if (!reason) return
    await this.locked(async state => { if (!state.paused) { state.paused = { reason, at: this.now() }; await this.save(state) } })
  }
  async observe(response: Response): Promise<void> {
    const wait = retryAfterMs(response.headers.get('retry-after'), this.now())
    const reason = response.status === 429 ? 'rate-limit' : response.status === 402 ? 'quota' : response.status === 403 ? 'challenge' : undefined
    if (wait === undefined && !reason) return
    await this.locked(async state => {
      const now = this.now()
      if (wait !== undefined) state.until = Math.max(state.until, Math.min(Number.MAX_SAFE_INTEGER, now + wait))
      if (!state.paused && (reason || wait !== undefined && wait > Number.MAX_SAFE_INTEGER - now)) state.paused = { reason: reason ?? 'server-wait', at: now }
      await this.save(state)
    })
  }
}
