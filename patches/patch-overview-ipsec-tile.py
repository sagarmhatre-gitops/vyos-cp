#!/usr/bin/env python3
"""
patch-overview-ipsec-tile.py — add an IPsec tunnel-health KPI tile to the
device Overview dashboard, next to Throughput/Sessions/CPU/Memory.

What the tile shows:
  - Primary number: count of configured peers (always available)
  - Subtitle: "N up / M down" derived from the SA status poll
  - Color: warn if any peer is configured but not up
  - Click: navigates to /devices/{id}/ipsec
  - Empty state: "Not configured" muted, no link
  - Once the SA parser ships (item #4 on the original list), the up-count
    will reflect reality automatically; no UI change needed.

Run from /opt/vyos-cp. Idempotent.
"""
import os
import shutil
import sys

PATH = "frontend/src/pages/Overview.tsx"

# --- Patch 1: queries section ---------------------------------------------

QUERIES_OLD = '''  const auditQ = useQuery({
    queryKey: ['audit', id], queryFn: () => api.listAudit(id),
    enabled: !!id, refetchInterval: 30_000,
  })'''

QUERIES_NEW = '''  const auditQ = useQuery({
    queryKey: ['audit', id], queryFn: () => api.listAudit(id),
    enabled: !!id, refetchInterval: 30_000,
  })
  // IPsec health — config gives us peer count, status gives us SAs-up count.
  // Same query keys as the IPsec page so the data is shared (one network
  // request services both the dashboard tile and the full IPsec view).
  const ipsecQ = useQuery({
    queryKey: ['ipsec', id], queryFn: () => api.getIPsec(id!),
    enabled: !!id, staleTime: 30_000,
  })
  const ipsecStatusQ = useQuery({
    queryKey: ['ipsec-status', id], queryFn: () => api.getIPsecStatus(id!),
    enabled: !!id, refetchInterval: 15_000,
  })'''


# Pass the IPsec data down to OverviewBody as props.
PROPS_PASS_OLD = '''        <OverviewBody id={id!} ov={ov} ifaces={ifaces} audit={audit}
          throughput={throughputArr} latestRx={latestRx} latestTx={latestTx}
          memPct={memPct} device={device} />'''

PROPS_PASS_NEW = '''        <OverviewBody id={id!} ov={ov} ifaces={ifaces} audit={audit}
          throughput={throughputArr} latestRx={latestRx} latestTx={latestTx}
          memPct={memPct} device={device}
          ipsecPeers={ipsecQ.data?.peers} ipsecSAs={ipsecStatusQ.data} />'''


# Add the new props to OverviewBody's signature.
SIG_OLD = '''function OverviewBody({ id, ov, ifaces, audit, throughput, latestRx, latestTx, memPct, device }: {
  id: string
  ov: any
  ifaces: Interface[]
  audit: any[]
  throughput: any[]
  latestRx: number
  latestTx: number
  memPct: number | null
  device: any
}) {'''

SIG_NEW = '''function OverviewBody({ id, ov, ifaces, audit, throughput, latestRx, latestTx, memPct, device,
                       ipsecPeers, ipsecSAs }: {
  id: string
  ov: any
  ifaces: Interface[]
  audit: any[]
  throughput: any[]
  latestRx: number
  latestTx: number
  memPct: number | null
  device: any
  ipsecPeers?: Array<{ name: string; disable?: boolean }>
  ipsecSAs?: Array<{ peer: string; state: string }>
}) {'''


# --- Patch 2: insert the tile in the tile grid ----------------------------

TILE_OLD = '''        <Tile label="Memory"
          primary={memPct != null ? `${memPct}%` : '—'}
          subtitle={ov?.memory_total_mb && ov.memory_used_mb != null ?
            `${ov.memory_used_mb} / ${ov.memory_total_mb} MB` : ''}
          highlight={memPct != null && memPct > 85 ? 'warn' : undefined}>
          {memSeries.length > 1 && (
            <Sparkline values={memSeries} height={28} />
          )}
        </Tile>
      </div>'''

TILE_NEW = '''        <Tile label="Memory"
          primary={memPct != null ? `${memPct}%` : '—'}
          subtitle={ov?.memory_total_mb && ov.memory_used_mb != null ?
            `${ov.memory_used_mb} / ${ov.memory_total_mb} MB` : ''}
          highlight={memPct != null && memPct > 85 ? 'warn' : undefined}>
          {memSeries.length > 1 && (
            <Sparkline values={memSeries} height={28} />
          )}
        </Tile>

        {/* IPsec — tunnel-health KPI. One number per peer state; click-through
            to the full IPsec page. Empty state for devices that have no IPsec
            config at all. */}
        <IPsecTile
          deviceId={id}
          peers={ipsecPeers}
          sas={ipsecSAs} />
      </div>'''


# --- Patch 3: add the IPsecTile component definition ---------------------

# Insert it right before the existing Tile component definition.
TILE_COMPONENT_ANCHOR = "function Tile({ label, primary, subtitle, highlight, children }: {"

TILE_COMPONENT_NEW = '''// IPsecTile is the dashboard KPI for IPsec health. It composes the standard
// <Tile> with logic to pick the right primary number, subtitle, highlight,
// and link based on three states:
//
//   1. No peers configured  → muted "Not configured", no link
//   2. Peers configured, all up → green/neutral "N peers · N up"
//   3. Peers configured, some down → warn "N peers · A up / D down"
//
// The whole tile is a Link so clicking anywhere on it goes to the IPsec page.
function IPsecTile({ deviceId, peers, sas }: {
  deviceId: string
  peers?: Array<{ name: string; disable?: boolean }>
  sas?: Array<{ peer: string; state: string }>
}) {
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

  return (
    <Link to={`/devices/${deviceId}/ipsec`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Tile label="IPsec"
        primary={`${peerCount}`}
        subtitle={`${upCount} up / ${downCount} down`}
        highlight={highlight} />
    </Link>
  )
}

'''


def patch_replace(path, old, new, marker):
    if not os.path.exists(path):
        print(f"ERROR: {path} not found — run from /opt/vyos-cp", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        text = f.read()
    if marker in text:
        print(f"  · {path}: already patched (marker present)")
        return
    if old not in text:
        print(f"ERROR: anchor not found for marker {marker!r}", file=sys.stderr)
        sys.exit(1)
    bak = path + ".bak.ipsec-tile"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = text.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(text)
    print(f"  ✓ {path}: patched ({marker})")


def patch_insert_before(path, anchor, insertion, marker):
    with open(path) as f:
        text = f.read()
    if marker in text:
        print(f"  · {path}: already patched ({marker})")
        return
    if anchor not in text:
        print(f"ERROR: anchor not found for marker {marker!r}", file=sys.stderr)
        sys.exit(1)
    text = text.replace(anchor, insertion + anchor, 1)
    with open(path, "w") as f:
        f.write(text)
    print(f"  ✓ {path}: patched ({marker})")


def main():
    print("Adding IPsec health tile to device overview…\n")

    print("[1/5] Adding ipsecQ + ipsecStatusQ queries to Overview()")
    patch_replace(PATH, QUERIES_OLD, QUERIES_NEW, marker="const ipsecQ")

    print("[2/5] Passing IPsec data down to OverviewBody")
    patch_replace(PATH, PROPS_PASS_OLD, PROPS_PASS_NEW, marker="ipsecPeers={ipsecQ")

    print("[3/5] Adding IPsec props to OverviewBody signature")
    patch_replace(PATH, SIG_OLD, SIG_NEW, marker="ipsecPeers?: Array")

    print("[4/5] Inserting <IPsecTile /> into the KPI grid")
    patch_replace(PATH, TILE_OLD, TILE_NEW, marker="<IPsecTile")

    print("[5/5] Adding IPsecTile component definition")
    patch_insert_before(PATH, TILE_COMPONENT_ANCHOR, TILE_COMPONENT_NEW,
                        marker="function IPsecTile(")

    print()
    print("Done. Rebuild frontend:")
    print("  docker compose down && docker compose build app && docker compose up -d")


if __name__ == "__main__":
    main()
