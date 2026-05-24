// ConfirmDelete — a small reusable modal for destructive actions. Not
// fancy; just gets the right UX in one place so every delete button
// doesn't reinvent the pattern. Uses the existing .modal CSS classes.

import { useEffect } from 'react'

export function ConfirmDelete({ title, message, confirmLabel = 'Delete', onConfirm, onClose, pending }: {
  title: string
  message: React.ReactNode
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  pending?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  return (
    <div className="modal-backdrop" onClick={() => !pending && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 440 }}>
        <div className="modal-head">
          <h2 style={{ color: 'var(--danger)' }}>{title}</h2>
        </div>
        <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.55 }}>
          {message}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
