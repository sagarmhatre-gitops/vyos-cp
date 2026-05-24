// FleetHealthDonut — pie/donut chart of the fleet's health composition.
//
// SVG-only, no charting library (we already vetoed adding a chart dep when
// building Sparkline). Donut over solid pie because the empty middle gives
// us a place for the headline number ("18 / 21 healthy") which is what an
// operator actually needs to see — not the slices.
//
// Slice colors match the rest of the app's semantic tokens:
//   healthy  → --ok       (green)
//   warning  → --warn-ink (amber)
//   critical → --danger   (red)
//   stale    → --ink-faint (grey, "data is suspect")
//   unknown  → --ink-muted (grey, "no signal yet")

import { FleetHealth } from '../lib/api'

const SIZE = 140
const STROKE = 22

type Slice = { label: string; value: number; color: string; tone?: string }

export function FleetHealthDonut({ data }: { data: FleetHealth }) {
  const total = data.total
  // Unknown + stale are real states but visually they're "grey-not-green",
  // so we lump them with critical for the headline ratio while still showing
  // them in the legend with their own colors.
  const slices: Slice[] = [
    { label: 'Healthy',  value: data.healthy,  color: 'var(--ok)' },
    { label: 'Warning',  value: data.warning,  color: 'var(--warn-ink, #b45309)' },
    { label: 'Critical', value: data.critical, color: 'var(--danger, #dc2626)' },
    { label: 'Stale',    value: data.stale,    color: 'var(--ink-faint, #94a3b8)' },
    { label: 'Unknown',  value: data.unknown,  color: 'var(--ink-muted, #64748b)' },
  ].filter(s => s.value > 0)

  // Edge case: no devices at all (or before first poll). Render an empty
  // grey ring instead of a chart with zero slices.
  if (total === 0 || slices.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-title">Fleet health</span>
        </div>
        <div style={{ padding: 14, textAlign: 'center', color: 'var(--ink-muted)' }}>
          {total === 0 ? 'No devices yet.' : 'Collecting first metrics…'}
        </div>
      </div>
    )
  }

  // Build SVG arc segments. Conceptually we walk around the circle and emit
  // one stroked arc per slice, with stroke-dasharray sized to the slice's
  // share of the perimeter. SVG circumference = 2πr.
  const r = (SIZE - STROKE) / 2
  const cx = SIZE / 2
  const cy = SIZE / 2
  const circ = 2 * Math.PI * r

  let offset = 0
  const segments = slices.map(s => {
    const len = (s.value / total) * circ
    const seg = (
      <circle key={s.label}
        cx={cx} cy={cy} r={r}
        fill="none" stroke={s.color} strokeWidth={STROKE}
        strokeDasharray={`${len} ${circ - len}`}
        strokeDashoffset={-offset}
        // Rotate so the first slice starts at 12 o'clock instead of 3.
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    )
    offset += len
    return seg
  })

  // Headline number: healthy / total. The "/total" makes the ratio readable
  // even when the slice is small (vs. just "healthy 18").
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Fleet health</span>
        <span className="dim" style={{ fontSize: 11 }}>{total} device{total === 1 ? '' : 's'}</span>
      </div>
      <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <svg width={SIZE} height={SIZE}>{segments}</svg>
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 22, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
              {data.healthy}<span className="dim" style={{ fontSize: 14 }}>/{total}</span>
            </div>
            <div className="dim" style={{ fontSize: 10, marginTop: 2 }}>healthy</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {[
            { label: 'Healthy',  value: data.healthy,  color: 'var(--ok)' },
            { label: 'Warning',  value: data.warning,  color: 'var(--warn-ink, #b45309)' },
            { label: 'Critical', value: data.critical, color: 'var(--danger, #dc2626)' },
            { label: 'Stale',    value: data.stale,    color: 'var(--ink-faint, #94a3b8)' },
            { label: 'Unknown',  value: data.unknown,  color: 'var(--ink-muted, #64748b)' },
          ].map(s => (
            <div key={s.label} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 12, padding: '2px 0',
              opacity: s.value > 0 ? 1 : 0.4,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: 2,
                background: s.color, flexShrink: 0,
              }}/>
              <span style={{ flex: 1 }}>{s.label}</span>
              <span className="mono">{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
