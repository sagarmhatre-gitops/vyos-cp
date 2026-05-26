import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, UsageRollup } from '../lib/api'

// UsageView — accumulated bandwidth usage from the counter-based metering
// pipeline. Real, ground-truth bytes. A period selector (hour / day / month)
// switches the granularity; the API serves hourly, daily, and monthly rollups,
// all derived from the same counter snapshots. Periods where a counter reset
// occurred are flagged so the number's trustworthiness stays visible.

type Period = 'hour' | 'day' | 'month'

function fmtBytes(b: number): string {
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB'
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB'
  return b + ' B'
}

// per-period config: how far back to fetch, how many bars, and how to label.
const PERIOD_CFG: Record<Period, { hours: number; bars: number; label: string; sub: string }> = {
  hour:  { hours: 48,        bars: 24, label: 'last 48h',  sub: 'hourly' },
  day:   { hours: 24 * 30,   bars: 30, label: 'last 30d',  sub: 'daily' },
  month: { hours: 24 * 365,  bars: 12, label: 'last 12mo', sub: 'monthly' },
}

// label for a single bar, given the period type.
function barLabel(d: Date, period: Period): string {
  if (period === 'hour') return String(d.getUTCHours())
  if (period === 'day') return String(d.getUTCDate())
  return d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })
}

// title for the "current" and "total" stat tiles, per period.
function statLabels(period: Period): { current: string; total: string } {
  if (period === 'hour') return { current: 'This hour', total: 'Today' }
  if (period === 'day') return { current: 'Today', total: 'This month' }
  return { current: 'This month', total: 'This year' }
}

type AxisSlot = { period_start: string; rx_bytes: number; tx_bytes: number; had_reset: boolean; empty: boolean }

// utcFloorKey floors a Date to the start of its UTC hour/day/month -> epoch ms.
// Rollup period_start is UTC; flooring both sides in UTC is what makes them match.
function utcFloorKey(d: Date, period: Period): number {
  if (period === 'hour') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
  if (period === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

// buildAxis fills the full window: one slot per period in chronological order,
// zero for periods with no rollup. Matching is on UTC-floored epoch keys.
function buildAxis(rows: UsageRollup[], bars: number, period: Period): AxisSlot[] {
  const idx = new Map<number, UsageRollup>()
  for (const r of rows) idx.set(utcFloorKey(new Date(r.period_start), period), r)
  const nowKey = utcFloorKey(new Date(), period)
  const slots: AxisSlot[] = []
  for (let i = bars - 1; i >= 0; i--) {
    const anchor = new Date(nowKey)
    if (period === 'hour') anchor.setUTCHours(anchor.getUTCHours() - i)
    else if (period === 'day') anchor.setUTCDate(anchor.getUTCDate() - i)
    else anchor.setUTCMonth(anchor.getUTCMonth() - i)
    const key = utcFloorKey(anchor, period)
    const r = idx.get(key)
    slots.push({
      period_start: new Date(key).toISOString(),
      rx_bytes: r ? r.rx_bytes : 0,
      tx_bytes: r ? r.tx_bytes : 0,
      had_reset: r ? r.had_reset : false,
      empty: !r,
    })
  }
  return slots
}

export function UsageView({ deviceId }: { deviceId: string }) {
  const [period, setPeriod] = useState<Period>('hour')
  const cfg = PERIOD_CFG[period]

  const q = useQuery({
    queryKey: ['usage', deviceId, period],
    queryFn: () => api.deviceUsage(deviceId, period, cfg.hours),
    enabled: !!deviceId,
    refetchInterval: 60_000,
  })

  const rows: UsageRollup[] = (q.data ?? []).filter((r) => r.scope === 'device')
  const now = new Date()

  // "current" bucket = the period containing now.
  const sameBucket = (a: Date, b: Date): boolean => {
    if (period === 'hour') return a.toISOString().slice(0, 13) === b.toISOString().slice(0, 13)
    if (period === 'day') return a.toDateString() === b.toDateString()
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  }
  const current = rows.find((r) => sameBucket(new Date(r.period_start), now))

  // "total" tile = sum across the coarser containing window.
  const inTotalWindow = (d: Date): boolean => {
    if (period === 'hour') return d.toDateString() === now.toDateString()            // today
    if (period === 'day') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() // this month
    return d.getFullYear() === now.getFullYear()                                     // this year
  }
  const totals = rows
    .filter((r) => inTotalWindow(new Date(r.period_start)))
    .reduce((acc, r) => ({ rx: acc.rx + r.rx_bytes, tx: acc.tx + r.tx_bytes }), { rx: 0, tx: 0 })

  const maxBar = Math.max(1, ...rows.map((r) => r.rx_bytes + r.tx_bytes))
  const anyReset = rows.some((r) => r.had_reset)
  const labels = statLabels(period)
  const curTotal = current ? current.rx_bytes + current.tx_bytes : 0

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <span className="card-title">Data Transfer</span>
        <div className="usage-controls">
          <div className="usage-period-toggle">
            {(['hour', 'day', 'month'] as Period[]).map((p) => (
              <button
                key={p}
                className={'usage-period-btn' + (p === period ? ' active' : '')}
                onClick={() => setPeriod(p)}
              >
                {p === 'hour' ? 'Hourly' : p === 'day' ? 'Daily' : 'Monthly'}
              </button>
            ))}
          </div>
          <span className="dim" style={{ fontSize: 11 }}>measured · {cfg.label}</span>
        </div>
      </div>
      <div className="usage-body">
        <div className="usage-totals">
          <div className="usage-stat">
            <div className="usage-stat-label">{labels.current}</div>
            <div className="usage-stat-val mono">{fmtBytes(curTotal)}</div>
            <div className="usage-stat-sub mono">
              ↓ {fmtBytes(current?.rx_bytes ?? 0)} · ↑ {fmtBytes(current?.tx_bytes ?? 0)}
            </div>
          </div>
          <div className="usage-stat">
            <div className="usage-stat-label">{labels.total}</div>
            <div className="usage-stat-val mono">{fmtBytes(totals.rx + totals.tx)}</div>
            <div className="usage-stat-sub mono">↓ {fmtBytes(totals.rx)} · ↑ {fmtBytes(totals.tx)}</div>
          </div>
        </div>
        <div className="usage-chart">
          {q.isLoading ? (
            <div className="dim" style={{ fontSize: 12, padding: 20 }}>Loading usage…</div>
          ) : rows.length === 0 ? (
            <div className="dim" style={{ fontSize: 12, padding: 20 }}>
              {period === 'hour'
                ? 'Accumulating usage — the rollup runs every few minutes.'
                : `No ${cfg.sub} data yet — derived from hourly rollups as they accumulate.`}
            </div>
          ) : (
            <div className="usage-bars">
              {buildAxis(rows, cfg.bars, period).map((r, i) => {
                const total = r.rx_bytes + r.tx_bytes
                const h = Math.max(2, (total / maxBar) * 100)
                const d = new Date(r.period_start)
                return (
                  <div
                    key={i}
                    className="usage-bar-col"
                    title={`${fmtBytes(total)} · ${d.toLocaleString()}${r.had_reset ? ' (counter reset in this period)' : ''}`}
                  >
                    <div className={'usage-bar' + (r.had_reset ? ' reset' : '')} style={{ height: `${h}%` }} />
                    <div className="usage-bar-lbl mono">{barLabel(d, period)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {anyReset && (
          <div className="usage-note dim">
            ⚠ Some periods include a counter reset (device reboot). Usage during the
            reset instant is conservatively under-counted — never over-counted.
          </div>
        )}
      </div>
    </div>
  )
}
