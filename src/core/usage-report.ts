import type { LocalStore } from '../local/store.js'
import type { WebUsageReport } from './account-types.js'
import { metricView } from './metrics.js'

/** Local observations only: never fetch, estimate, sum branch snapshots or emit API usage. */
export async function webUsageReport(store: Pick<LocalStore, 'account' | 'sessionKeys' | 'session' | 'pending'>,
  keyFor: (sessionId: string) => string): Promise<WebUsageReport> {
  const account = await store.account()
  const empty = (): WebUsageReport => ({ rows: [], unreadableSessions: 0 })
  if (!account.accountKey || account.credentialHash === null) return empty()
  const report = empty()
  for (const key of await store.sessionKeys()) {
    try {
      const session = await store.session(key)
      if (!session || session.accountKey !== account.accountKey || keyFor(session.sessionId) !== key) continue
      const pending = Boolean(await store.pending(key))
      const view = metricView({ ...session, metricsCurrent: session.metricsCurrent && session.metricsEpoch === account.epoch && !pending })
      report.rows.push({ sessionId: session.sessionId, state: view.count === undefined ? session.usage ? 'stale' : 'unknown' : 'confirmed',
        count: view.count, previousCount: view.count === undefined ? session.usage?.accumulated_token_usage : undefined,
        observedAt: session.usage?.observedAt, pending })
    } catch { report.unreadableSessions++ }
  }
  const after = await store.account()
  if (after.epoch !== account.epoch || after.accountKey !== account.accountKey || after.credentialHash === null) return empty()
  report.rows.sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? '') || a.sessionId.localeCompare(b.sessionId))
  return report
}
