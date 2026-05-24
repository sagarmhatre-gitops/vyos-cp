import { ReactNode, useEffect } from 'react'

// Modal shell that does NOT dismiss on backdrop click. Users must click
// the ✕ button, Cancel, or press Escape. If `dirty` is true, Escape and ✕
// prompt for confirmation.
//
// When `busy` is true, the modal body is overlaid with a translucent panel
// and a spinner. Keyboard close (Escape) and the ✕ button are also blocked
// while busy, so the operator can't accidentally dismiss a modal mid-submit
// and lose track of whether their change went through.
export function Modal({ title, onClose, dirty, busy, children, footer, wide }: {
  title: string
  onClose: () => void
  dirty?: boolean
  busy?: boolean
  children: ReactNode
  footer?: ReactNode
  /** If true, use the wider .modal.wide variant (880px). Used by the
   *  Add IPsec peer wizard which has a side summary panel. */
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (busy) return                            // never dismiss while submitting
        if (dirty && !confirm('Discard your changes?')) return
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, dirty, busy])

  const handleClose = () => {
    if (busy) return
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }

  return (
    <div className="modal-backdrop">
      <div className={"modal" + (wide ? " wide" : "")} onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn" type="button" onClick={handleClose}
            disabled={busy}
            style={{ background: 'transparent', border: 0, opacity: busy ? 0.4 : 1 }}
            aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}

        {busy && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(255,255,255,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 10, borderRadius: 'inherit',
            pointerEvents: 'auto',
          }}>
            <Spinner label="Working…" />
          </div>
        )}
      </div>
    </div>
  )
}

// Spinner — pure CSS, no SVG/image dependency.
export function Spinner({ label, size = 24 }: { label?: string; size?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: size, height: size,
        border: `2px solid var(--line, #e5e7eb)`,
        borderTopColor: 'var(--primary, #2563eb)',
        borderRadius: '50%',
        animation: 'modal-spin 700ms linear infinite',
      }} />
      {label && <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{label}</div>}
      <style>{`
        @keyframes modal-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

// Helper: handleCancel that respects dirty state, for Cancel buttons.
export function cancelHandler(onClose: () => void, dirty?: boolean) {
  return () => {
    if (dirty && !confirm('Discard your changes?')) return
    onClose()
  }
}
