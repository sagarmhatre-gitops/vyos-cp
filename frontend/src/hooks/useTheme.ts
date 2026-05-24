// Theme preference management.
//
// We support three modes: "light", "dark", "auto". Auto follows the OS via
// CSS media query. The user's choice persists across sessions in localStorage
// under "vyos-cp.theme". The hook applies `data-theme` to <html> on mount and
// on every change so that the CSS variable overrides take effect.
//
// Why a string union instead of just a boolean: operators sometimes want
// dark all-day (NOC environment), light all-day (printing dashboards), or
// "match my laptop" — supporting all three with one toggle is friendlier
// than a binary flip that fights against the OS preference.

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'vyos-cp.theme'

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    // localStorage unavailable (private mode, blocked) — fall through.
  }
  return 'light' // Default to light to match the target design.
}

function applyTheme(t: Theme) {
  // Setting the attribute on <html> rather than <body> ensures the
  // background-color cascade reaches the html element too, avoiding a
  // brief flash of the wrong color during page transitions.
  document.documentElement.setAttribute('data-theme', t)
}

/** Apply the saved theme as early as possible — before React mounts. Call
 *  this from main.tsx to avoid a flash of light theme on dark-preferring
 *  users. Idempotent. */
export function initThemeEarly() {
  applyTheme(readStored())
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStored)

  // Apply on mount + on every change.
  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignore */ }
  }, [theme])

  const setTheme = useCallback((t: Theme) => setThemeState(t), [])

  // Convenience: cycle through light → dark → auto so a single click
  // doesn't require a dropdown for casual use.
  const cycle = useCallback(() => {
    setThemeState(t => t === 'light' ? 'dark' : t === 'dark' ? 'auto' : 'light')
  }, [])

  return { theme, setTheme, cycle }
}
