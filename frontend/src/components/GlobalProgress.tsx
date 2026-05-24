import { useIsFetching, useIsMutating } from '@tanstack/react-query'

// GlobalProgress renders a 2px progress bar at the very top of the viewport
// that activates whenever any react-query mutation OR a fetch is in flight.
// Pure CSS, no portal.
export function GlobalProgress() {
  const fetching = useIsFetching()
  const mutating = useIsMutating()
  const active = fetching + mutating > 0

  return (
    <>
      <div
        aria-hidden={!active}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0,
          height: 2, zIndex: 9999,
          background: 'transparent',
          pointerEvents: 'none',
          opacity: active ? 1 : 0,
          transition: 'opacity 200ms ease-out',
        }}
      >
        <div style={{
          height: '100%',
          background: 'var(--ok, #2BE0A6)',
          boxShadow: '0 0 10px rgba(43,224,166,0.6)',
          animation: active ? 'gp-slide 1.2s ease-in-out infinite' : 'none',
        }} />
      </div>
      <style>{`
        @keyframes gp-slide {
          0%   { transform: translateX(-60%); width: 30%; }
          50%  { transform: translateX(40%);  width: 60%; }
          100% { transform: translateX(120%); width: 30%; }
        }
      `}</style>
    </>
  )
}
