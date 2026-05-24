import { useEffect } from 'react'

// useEscape registers a global keydown listener that invokes onEscape
// when the user presses the Escape key. Intended for modal dismissal.
export function useEscape(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape, active])
}
