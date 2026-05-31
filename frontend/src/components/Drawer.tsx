import { ReactNode, useEffect } from 'react'

// Drawer is a right-side overlay panel with a darkened backdrop. The
// shell content stays visible underneath but pointer events are
// captured by the backdrop.
//
// API mirrors Modal.tsx as closely as possible so the two feel like
// siblings rather than parallel inventions. Same dirty/busy semantics:
//   - Backdrop clicks do NOT dismiss (avoid accidental loss-of-changes)
//   - Escape dismisses, but prompts when dirty
//   - When busy, dismissal is blocked entirely
//
// Used by VPNProfileDrawer for create/edit. Will be reused for Peers,
// Traffic Selectors, and Tunnel Composer in Phases 3-5.
//
// CSS classes used (added in the patch alongside this component):
//   .drawer-backdrop   — full-screen translucent overlay
//   .drawer            — sliding panel container (right side, 560px)
//   .drawer-head       — header bar with title + close button
//   .drawer-body       — scrollable content area
//   .drawer-foot       — sticky footer with action buttons
export function Drawer({
  title, onClose, dirty, busy, children, footer, wide,
}: {
  title: string
  onClose: () => void
  dirty?: boolean
  busy?: boolean
  children: ReactNode
  footer?: ReactNode
  /** Wider variant (720px) for forms with multi-column layout. */
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (busy) return
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
    <div className="drawer-backdrop">
      <div
        className={'drawer' + (wide ? ' wide' : '')}
        onClick={e => e.stopPropagation()}
        style={{ position: 'relative' }}
      >
        <div className="drawer-head">
          <h2>{title}</h2>
          <button
            className="btn"
            type="button"
            onClick={handleClose}
            disabled={busy}
            style={{ background: 'transparent', border: 0, opacity: busy ? 0.4 : 1 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
        {busy && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(255,255,255,0.55)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              pointerEvents: 'auto',
            }}
          >
            <div className="spinner" />
          </div>
        )}
      </div>
    </div>
  )
}
