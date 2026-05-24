// Loading — a centered, NOC-themed glowing spinner for tab/content load states.
// Reserves vertical space (minHeight) so the page doesn't reflow ("snap") when
// data arrives. Use inside a query's isLoading branch.

export function Loading({ label = 'Loading…', minHeight = 220 }: { label?: string; minHeight?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, minHeight,
      }}
    >
      <span className="noc-spinner" />
      <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}>
        {label}
      </span>
    </div>
  )
}

// A table-row variant: drops into a <tbody> in place of the old "Loading…" <tr>.
// colSpan must match the table's column count.
export function LoadingRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: 0 }}>
        <Loading minHeight={160} />
      </td>
    </tr>
  )
}
