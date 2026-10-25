import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { WebUsageReport } from 'dsh-tokenfree/account-types'

export function WebUsagePanel({ load }: { load: () => Promise<WebUsageReport> }) {
  const [report, setReport] = useState<WebUsageReport>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try { const value = await load(); if (live) { setReport(value); setFailed(false) } }
      catch { if (live) { setReport(undefined); setFailed(true) } }
      finally { if (live) timer = setTimeout(refresh, 5000) }
    }
    void refresh()
    return () => { live = false; clearTimeout(timer) }
  }, [load, revision])
  return <section aria-label="TokenFree 网页用量" style={{ padding: '12px 20px', borderBottom: '1px solid var(--dsw-alias-border-primary, #8884)', maxHeight: '35vh', overflow: 'auto', flexShrink: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <strong>TokenFree 网页用量</strong>
      <button type="button" onClick={() => setRevision(n => n + 1)}>刷新网页用量</button>
    </div>
    <p style={{ margin: '6px 0', fontSize: 12 }}>官网分支累计 token · 本机最近观测，不是历史消耗或账号额度。各会话不相加，不计入下方 API token、费用和缓存命中率。刷新仅读取本机记录。</p>
    {failed ? <p role="status">网页用量读取失败，请稍后刷新；未将未知数据记为 0。</p> : !report ? <p role="status">正在读取网页用量…</p> : <>
      {report.unreadableSessions > 0 && <p role="status">{report.unreadableSessions} 份会话记录无法读取，未计入列表。</p>}
      {!report.rows.length ? <p>当前账号暂无可读的网页会话用量记录。</p> : <details open>
        <summary>{report.rows.length} 个网页会话 · 每行独立显示</summary>
        <table style={{ width: '100%', textAlign: 'left', fontSize: 12, borderSpacing: '8px 4px' }}>
          <thead><tr><th>DSH 会话</th><th>官网分支累计 token</th><th>状态</th><th>观测时间</th></tr></thead>
          <tbody>{report.rows.map(row => <tr key={row.sessionId}>
            <td title={row.sessionId}>{row.sessionId.slice(-12)}</td>
            <td>{row.count !== undefined ? row.count.toLocaleString() : row.previousCount !== undefined ? `${row.previousCount.toLocaleString()}（旧观测）` : '未知'}</td>
            <td>{row.pending ? '处理中，待结算' : row.state === 'confirmed' ? '官网已确认' : row.state === 'stale' ? '待重新观测' : '未提供'}</td>
            <td>{row.observedAt && Number.isFinite(Date.parse(row.observedAt)) ? new Date(row.observedAt).toLocaleString() : '未知'}</td>
          </tr>)}</tbody>
        </table>
      </details>}
    </>}
  </section>
}

/** Decorate the public usage panel seat without editing or redistributing its implementation. */
export function installWebUsagePanel(ctx: Context, load: () => Promise<WebUsageReport>): () => void {
  const slots = ctx.slots
  return slots.inject('main', () => {
    let previous: StoredEntry | undefined, release = () => {}
    const View = (props: Record<string, unknown>) => {
      const Original = previous?.component as ComponentType<Record<string, unknown>> | undefined
      return Original ? <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <WebUsagePanel load={load} /><div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><Original {...props} /></div>
      </div> : null
    }
    const refresh = () => {
      const candidate = slots.entries('main').filter(entry => entry.options.key === 'usage' && entry.component !== View)
        .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
      if (candidate === previous) return
      release(); release = () => {}; previous = undefined
      // Unknown future seats retain their own wiring. This known root seat has no children/store.
      if (!candidate || candidate.locale !== 'usage' || !candidate.inject || candidate.children || candidate.store || candidate.select) return
      previous = candidate
      // Third-party locale/business props are runtime-owned: preserve the exact factory and namespace.
      const register = slots.register.bind(slots) as unknown as (options: Record<string, unknown>, view: ComponentType<Record<string, unknown>>) => () => void
      release = register({ ...candidate.options, name: 'main', priority: (candidate.options.priority ?? 0) - 1,
        locale: candidate.locale, inject: candidate.inject }, View)
    }
    const unsubscribe = slots.subscribe('main', refresh)
    refresh()
    return () => { unsubscribe(); release(); previous = undefined }
  })
}
