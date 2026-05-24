#!/usr/bin/env python3
"""
patch-overview-ipsec-tile-fix3.py — actual fix for the IPsec tile shrink.

Diagnosis from user testing:
  The tile renders fine on first paint (empty "Not configured" state) but
  shrinks the moment IPsec data loads and the component switches to the
  branch that wraps <Tile> in a clickable <div>. The empty-state branch
  uses <Tile> directly as a grid child; the loaded branch puts a wrapper
  div between the grid and the .card. The wrapper has no width:100%, so
  it sizes to content, and the grid track follows.

Fix: add `onClick` + `clickable` props to <Tile> itself. The IPsec tile
becomes a clickable card with NO wrapper div. Both render branches now
produce the same DOM shape (Tile → grid child), and the grid sizes all
five tracks identically regardless of which branch is taken.

Run from /opt/vyos-cp. Idempotent.
"""
import os
import shutil
import sys

PATH = "frontend/src/pages/Overview.tsx"

# --- Patch 1: revert IPsecTile to not wrap in a div --------------------

OLD_IPSEC_TILE = '''function IPsecTile({ deviceId, peers, sas }: {
  deviceId: string
  peers?: Array<{ name: string; disable?: boolean }>
  sas?: Array<{ peer: string; state: string }>
}) {
  const navigate = useNavigate()
  const peerCount = peers?.length ?? 0
  if (peerCount === 0) {
    return (
      <Tile label="IPsec" primary="—" subtitle="Not configured" />
    )
  }
  // Count up unique peers that have at least one SA in "up" state.
  const upPeers = new Set(
    (sas || []).filter(s => s.state === 'up').map(s => s.peer)
  )
  const upCount = upPeers.size
  const downCount = peerCount - upCount
  const highlight = downCount > 0 ? 'warn' as const : undefined

  // We previously wrapped <Tile> in <Link>, but an <a> as a grid child
  // confused auto-fit's sizing — even with display:block + height:100%
  // the tile rendered narrower than its siblings. Making the <Tile> div
  // itself clickable keeps it structurally identical to the other tiles
  // and the grid sizes all five tracks equally.
  return (
    <div onClick={() => navigate(`/devices/${deviceId}/ipsec`)}
      style={{ cursor: 'pointer' }}>
      <Tile label="IPsec"
        primary={`${peerCount}`}
        subtitle={`${upCount} up / ${downCount} down`}
        highlight={highlight} />
    </div>
  )
}'''

NEW_IPSEC_TILE = '''function IPsecTile({ deviceId, peers, sas }: {
  deviceId: string
  peers?: Array<{ name: string; disable?: boolean }>
  sas?: Array<{ peer: string; state: string }>
}) {
  const navigate = useNavigate()
  const peerCount = peers?.length ?? 0
  if (peerCount === 0) {
    return (
      <Tile label="IPsec" primary="—" subtitle="Not configured" />
    )
  }
  // Count up unique peers that have at least one SA in "up" state.
  const upPeers = new Set(
    (sas || []).filter(s => s.state === 'up').map(s => s.peer)
  )
  const upCount = upPeers.size
  const downCount = peerCount - upCount
  const highlight = downCount > 0 ? 'warn' as const : undefined

  // No wrapper div. <Tile> handles its own onClick — both render branches
  // (empty state vs loaded) produce the same DOM shape (Tile → grid child)
  // so the grid sizes all five tracks equally regardless of state.
  return (
    <Tile label="IPsec"
      primary={`${peerCount}`}
      subtitle={`${upCount} up / ${downCount} down`}
      highlight={highlight}
      onClick={() => navigate(`/devices/${deviceId}/ipsec`)} />
  )
}'''


# --- Patch 2: add onClick prop to <Tile> --------------------------------

OLD_TILE_SIG = '''function Tile({ label, primary, subtitle, highlight, children }: {
  label: string; primary: React.ReactNode; subtitle?: React.ReactNode
  highlight?: 'warn' | 'crit'; children?: React.ReactNode
}) {
  // Border color shifts when warn/crit so high-pressure metrics catch the eye.
  const borderColor = highlight === 'crit' ? 'var(--danger)'
    : highlight === 'warn' ? 'var(--warn, #e08e00)'
    : 'var(--line)'
  return (
    <div className="card" style={{
      padding: 14, borderLeft: `3px solid ${borderColor}`,
    }}>'''

NEW_TILE_SIG = '''function Tile({ label, primary, subtitle, highlight, children, onClick }: {
  label: string; primary: React.ReactNode; subtitle?: React.ReactNode
  highlight?: 'warn' | 'crit'; children?: React.ReactNode
  // Optional click handler. When provided, the card gets cursor:pointer
  // and is keyboard-focusable. The card otherwise renders identically —
  // critically, it's still a plain <div className="card"> so the grid
  // sizing is consistent across clickable and non-clickable tiles.
  onClick?: () => void
}) {
  // Border color shifts when warn/crit so high-pressure metrics catch the eye.
  const borderColor = highlight === 'crit' ? 'var(--danger)'
    : highlight === 'warn' ? 'var(--warn, #e08e00)'
    : 'var(--line)'
  return (
    <div className="card"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      style={{
        padding: 14, borderLeft: `3px solid ${borderColor}`,
        cursor: onClick ? 'pointer' : undefined,
      }}>'''


MARKERS = {
    "ipsec": "No wrapper div. <Tile> handles its own onClick",
    "tile":  "Optional click handler. When provided",
}


def patch_replace(path, old, new, marker):
    if not os.path.exists(path):
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        text = f.read()
    if marker in text:
        print(f"  · {path}: already patched")
        return
    if old not in text:
        print(f"ERROR: anchor not found for marker {marker!r}", file=sys.stderr)
        sys.exit(1)
    bak = path + ".bak.tile-fix3"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = text.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(text)
    print(f"  ✓ {path}: patched")


def main():
    print("Making <Tile> itself clickable, dropping IPsec wrapper div…\n")
    print("[1/2] Adding onClick prop to <Tile>")
    patch_replace(PATH, OLD_TILE_SIG, NEW_TILE_SIG, MARKERS["tile"])
    print("[2/2] Updating IPsecTile to use Tile's onClick prop")
    patch_replace(PATH, OLD_IPSEC_TILE, NEW_IPSEC_TILE, MARKERS["ipsec"])
    print()
    print("Rebuild: docker compose down && docker compose build app && docker compose up -d")


if __name__ == "__main__":
    main()
