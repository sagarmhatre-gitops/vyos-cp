import { useEffect, useRef, useState } from 'react'

// Autocomplete renders a text input whose suggestions are filtered from
// `options` as the user types. Users can either pick from the list or
// type a free-form value — required because VyOS will accept names that
// don't exist yet (deferred validation at commit time).
export function Autocomplete({ value, onChange, options, placeholder, list }: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label?: string; hint?: string }>
  placeholder?: string
  list?: string // if provided, render as a native <datalist> instead (simpler)
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Native <datalist> path — simpler, works everywhere, no outside-click
  // handling needed. Use this when options are short and the styling isn't
  // critical.
  if (list) {
    const listID = `dl-${list}`
    return (
      <>
        <input type="text" list={listID} value={value}
          onChange={e => onChange(e.target.value)} placeholder={placeholder} />
        <datalist id={listID}>
          {options.map(o => (
            <option key={o.value} value={o.value}>
              {o.label || o.hint || ''}
            </option>
          ))}
        </datalist>
      </>
    )
  }

  // Custom combobox with rich suggestion rows.
  const filtered = options.filter(o =>
    !value || o.value.toLowerCase().includes(value.toLowerCase()) ||
    (o.label && o.label.toLowerCase().includes(value.toLowerCase()))
  )

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  const pick = (v: string) => {
    onChange(v); setOpen(false)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input type="text" value={value} placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, filtered.length - 1)); setOpen(true) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter' && open && filtered[hi]) { e.preventDefault(); pick(filtered[hi].value) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
          background: 'var(--bg-raised)', border: '1px solid var(--line-strong)',
          borderRadius: 'var(--radius)', marginTop: 2,
          maxHeight: 220, overflowY: 'auto',
          boxShadow: 'var(--shadow)',
        }}>
          {filtered.slice(0, 30).map((o, i) => (
            <div key={o.value}
              onMouseDown={e => { e.preventDefault(); pick(o.value) }}
              onMouseEnter={() => setHi(i)}
              style={{
                padding: '6px 10px', cursor: 'pointer', fontSize: 12.5,
                background: i === hi ? 'var(--brand-soft)' : 'transparent',
                display: 'flex', justifyContent: 'space-between', gap: 10,
              }}>
              <span className="mono">{o.value}</span>
              {o.hint && <span className="dim" style={{ fontSize: 11 }}>{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
