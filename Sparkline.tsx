// Sparkline — pure SVG, no deps. Renders a small chart for a numeric
// series. Used for throughput history on the dashboard and interfaces page.
//
// `variant` controls visual style:
//   - 'area' (default, current): filled area chart with stroked top line
//   - 'line': stroke only, with a very subtle gradient fill underneath
//             (matches the dashboard mockup's KPI tile style)
//   - 'bars': vertical bars, one per data point (handy for discrete values)

export function Sparkline({
  values, width = 120, height = 32,
  color = 'var(--brand)',
  variant = 'area',
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  variant?: 'area' | 'line' | 'bars'
}) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <line x1={0} y1={height - 1} x2={width} y2={height - 1}
          stroke="var(--line)" strokeWidth={1} strokeDasharray="2,2" />
      </svg>
    )
  }
  const max = Math.max(...values, 1)

  if (variant === 'bars') {
    const barWidth = Math.max(1, (width / values.length) - 1)
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        {values.map((v, i) => {
          const x = i * (width / values.length)
          const h = (v / max) * (height - 2)
          const y = height - h - 1
          return <rect key={i} x={x} y={y} width={barWidth} height={h} fill={color} fillOpacity={0.7} />
        })}
      </svg>
    )
  }

  const step = width / (values.length - 1)
  const pts = values.map((v, i) => {
    const x = i * step
    const y = height - (v / max) * (height - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  if (variant === 'line') {
    // Line with very subtle area for visual depth without filling the
    // whole tile. Matches the mockup's KPI sparkline style.
    const area = `M 0,${height} L ${pts.replace(/ /g, ' L ')} L ${width},${height} Z`
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <path d={area} fill={color} fillOpacity={0.06} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5}
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    )
  }

  // 'area' — original behavior, kept as default for backward compatibility.
  const area = `M 0,${height} L ${pts.replace(/ /g, ' L ')} L ${width},${height} Z`
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={area} fill={color} fillOpacity={0.15} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

// Format a bps value as "1.2 Gbps", "340 Mbps", etc.
export function fmtBps(bps: number): string {
  if (bps < 1e3) return `${bps} bps`
  if (bps < 1e6) return `${(bps / 1e3).toFixed(1)} Kbps`
  if (bps < 1e9) return `${(bps / 1e6).toFixed(1)} Mbps`
  return `${(bps / 1e9).toFixed(2)} Gbps`
}

export function fmtPps(pps: number): string {
  if (pps < 1e3) return `${pps} p/s`
  if (pps < 1e6) return `${(pps / 1e3).toFixed(1)}K p/s`
  return `${(pps / 1e6).toFixed(1)}M p/s`
}
