// GlobalSearch — the ⌘K topbar search.
//
// Behavior summary:
//   - ⌘K (mac) or Ctrl+K (others) focuses the input from anywhere
//   - Esc clears + blurs
//   - ↑ / ↓ navigate the dropdown, Enter activates the highlighted hit
//   - Click-outside closes the dropdown
//   - 200 ms debounce on the API call so each keystroke doesn't spam
//   - Empty/whitespace query → no dropdown; no API call
//
// We deliberately don't paginate. The backend caps at 20 hits and the
// dropdown is finite real estate; if a user needs more they can refine.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, SearchHit } from '../lib/api'

export function GlobalSearch() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)

  // ⌘K / Ctrl+K hotkey — bound to window so it works from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Click-outside to close.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  // Debounced search. The 200 ms feels responsive without spamming the API
  // on fast typists. Cancellation comes from the cleanup, which clears the
  // pending timer when q changes again before the timer fires.
  useEffect(() => {
    const trimmed = q.trim()
    if (!trimmed) {
      setHits([])
      setLoading(false)
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const results = await api.search(trimmed)
        setHits(results || [])
        setHighlight(0)
        setOpen(true)
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [q])

  function activate(h: SearchHit) {
    setOpen(false)
    setQ('')
    if (h.kind === 'device') navigate(`/devices/${h.id}`)
    else if (h.kind === 'user') navigate(`/users`)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQ('')
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (!open || hits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(hits[highlight])
    }
  }

  // Detect mac vs others to show the right modifier in the placeholder.
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const shortcut = isMac ? '⌘K' : 'Ctrl+K'

  return (
    <div ref={containerRef} className="global-search">
      <span className="search-icon" aria-hidden>⌕</span>
      <input
        ref={inputRef}
        type="text"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => q.trim() && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={`Search devices, IPs, users…   ${shortcut}`}
        spellCheck={false}
        aria-label="Global search"
      />

      {open && q.trim() && (
        <div className="search-popover">
          {loading && hits.length === 0 && (
            <div className="search-empty">Searching…</div>
          )}
          {!loading && hits.length === 0 && (
            <div className="search-empty">No results for "{q}"</div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.kind}:${h.id}`}
              className={`search-hit ${i === highlight ? 'active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => activate(h)}>
              <span className={`search-kind kind-${h.kind}`}>{h.kind}</span>
              <span className="search-title">{h.title}</span>
              <span className="search-subtitle">{h.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
