// TagPills — render an array of tags as colored pills.
//
// Color is deterministic from the tag string (hash → palette index) so the
// same tag is always the same color across pages. Three special tags get
// fixed colors because they're semantically meaningful in operations:
//
//   "production" / "prod"  → red-ish (caution)
//   "staging" / "stage"     → amber  (transitional)
//   "dev" / "test"          → blue   (safe)
//
// Other tags rotate through a 6-color palette.

import React from 'react'

const PALETTE = [
  { bg: 'var(--brand-soft)',  fg: 'var(--brand-ink)' },
  { bg: 'var(--ok-soft)',     fg: 'var(--ok)' },
  { bg: 'var(--warn-soft)',   fg: 'var(--warn-ink)' },
  { bg: '#EDE9FE',            fg: '#5B21B6' }, // violet
  { bg: '#FEF3C7',            fg: '#92400E' }, // amber
  { bg: '#E0F2FE',            fg: '#075985' }, // sky
]

function semantic(tag: string): { bg: string; fg: string } | null {
  const t = tag.toLowerCase()
  if (t === 'production' || t === 'prod') return { bg: 'var(--danger-soft)', fg: 'var(--danger-ink)' }
  if (t === 'staging' || t === 'stage')   return { bg: 'var(--warn-soft)', fg: 'var(--warn-ink)' }
  if (t === 'dev' || t === 'test')        return { bg: 'var(--brand-soft)', fg: 'var(--brand-ink)' }
  return null
}

function colorFor(tag: string) {
  const sem = semantic(tag)
  if (sem) return sem
  // Cheap deterministic hash → palette index.
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

export function TagPills({ tags, size = 'md', onClick }: {
  tags?: string[]
  size?: 'sm' | 'md'
  /** When set, the pill becomes clickable — used for tag-as-filter UX. */
  onClick?: (tag: string) => void
}) {
  if (!tags || tags.length === 0) return null
  const fontSize = size === 'sm' ? 9.5 : 10.5
  const pad = size === 'sm' ? '1px 5px' : '2px 7px'
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {tags.map(tag => {
        const c = colorFor(tag)
        return (
          <span key={tag}
            onClick={onClick ? (e) => { e.stopPropagation(); onClick(tag) } : undefined}
            style={{
              display: 'inline-block', padding: pad,
              fontSize, fontFamily: 'var(--font-mono)', fontWeight: 500,
              borderRadius: 3, background: c.bg, color: c.fg,
              cursor: onClick ? 'pointer' : 'default',
              userSelect: 'none', whiteSpace: 'nowrap',
            }}>
            {tag}
          </span>
        )
      })}
    </span>
  )
}
