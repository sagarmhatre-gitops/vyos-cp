#!/usr/bin/env python3
"""
patch-vpn-peers-commit3.py — Phase 3A Commit 3 (frontend).

Adds the user-facing surface for fleet-wide peer management:

  - pages/VPNPeerDrawer.tsx   — read-only details drawer
  - pages/VPNPeersPage.tsx    — fleet table

Plus edits:
  - App.tsx                   — VPN nav adds "Peers", routes /vpn/peers
  - lib/api.ts                — 3 methods (list/get/delete) + types
  - pages/IPsec.tsx           — deep-link support for ?action=add and
                                ?peer={name}&action=edit

Idempotent. Run from /opt/vyos-cp.
"""
import os
import re
import shutil
import sys

REPO = os.getcwd()
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# New files
# ---------------------------------------------------------------------------

NEW_FILES = [
    ("VPNPeerDrawer.tsx", "frontend/src/pages/VPNPeerDrawer.tsx", "export function VPNPeerDrawer"),
    ("VPNPeersPage.tsx",  "frontend/src/pages/VPNPeersPage.tsx",  "export function VPNPeersPage"),
]


# ---------------------------------------------------------------------------
# App.tsx — three edits
# ---------------------------------------------------------------------------

APP_PATH = "frontend/src/App.tsx"

# 1. Add the new page component to imports. Anchor on the existing
#    VPNESPProfiles import which we know is there from Phase 1.
APP_IMPORT_OLD = "import { VPNESPProfiles } from './pages/VPNESPProfiles'"
APP_IMPORT_NEW = ("import { VPNESPProfiles } from './pages/VPNESPProfiles'\n"
                  "import { VPNPeersPage } from './pages/VPNPeersPage'")
APP_IMPORT_MARKER = "import { VPNPeersPage }"

# 2. Add the /vpn/peers route. Anchor on /vpn/esp-profiles which is
#    already there from Phase 1.
APP_ROUTES_OLD = '<Route path="/vpn/esp-profiles" element={<VPNESPProfiles />} />'
APP_ROUTES_NEW = ('<Route path="/vpn/esp-profiles" element={<VPNESPProfiles />} />\n'
                  '          <Route path="/vpn/peers" element={<VPNPeersPage />} />')
APP_ROUTES_MARKER = '"/vpn/peers"'

# 3. Add "Peers" link in the VPN nav group. Anchor on the existing
#    ESP Profiles Item which we shipped in Phase 1.
APP_NAV_OLD = ('<Item to="/vpn/esp-profiles" label="ESP Profiles" '
               "active={loc.pathname === '/vpn/esp-profiles'} />")
APP_NAV_NEW = ('<Item to="/vpn/esp-profiles" label="ESP Profiles" '
               "active={loc.pathname === '/vpn/esp-profiles'} />\n"
               '        <Item to="/vpn/peers" label="Peers" '
               "active={loc.pathname === '/vpn/peers'} />")
APP_NAV_MARKER = 'label="Peers"'


# ---------------------------------------------------------------------------
# lib/api.ts — types + methods. Same insertion strategy as the Phase 1 fix:
# insert types before `class API {` (line 316 give-or-take), insert methods
# right before the class's closing brace at line 705.
# ---------------------------------------------------------------------------

API_PATH = "frontend/src/lib/api.ts"

API_TYPES_BLOCK = '''// --- VPN peers (Phase 3A) ---------------------------------------------------

export type VPNPeer = {
  id: string
  name: string
  device_id: string
  device_name?: string
  peer?: Peer
  description: string
  tags: string[]
  created_by?: string
  updated_by?: string
  created_at?: string
  updated_at?: string
  used_by: string[]
}

'''

API_METHODS_BLOCK = '''
  // --- VPN peers (Phase 3A) ------------------------------------------------
  listVPNPeers() {
    return this.req<VPNPeer[]>(`/api/v1/vpn/peers`);
  }
  getVPNPeer(id: string) {
    return this.req<VPNPeer>(`/api/v1/vpn/peers/${id}`);
  }
  deleteVPNPeer(id: string) {
    return this.req<void>(`/api/v1/vpn/peers/${id}`, { method: 'DELETE' });
  }
'''

API_TYPES_MARKER = "export type VPNPeer = "
API_METHODS_MARKER = "listVPNPeers()"


# ---------------------------------------------------------------------------
# IPsec.tsx — deep-link support. Three changes:
#   1. Import useSearchParams alongside useParams
#   2. Read ?action and ?peer on mount; trigger setAdding or setEditingPeer
#   3. (no third change — handled by the useEffect)
# ---------------------------------------------------------------------------

IPSEC_PATH = "frontend/src/pages/IPsec.tsx"

# 1. Add useSearchParams to the react-router-dom import.
IPSEC_IMPORT_OLD = "import { useParams } from 'react-router-dom'"
IPSEC_IMPORT_NEW = "import { useParams, useSearchParams } from 'react-router-dom'"
IPSEC_IMPORT_MARKER = "useSearchParams"

# 2. Add the useEffect inside IPsec(). Anchor on the existing
#    `const [editingPeer, setEditingPeer] = useState<Peer | null>(null)` line
#    and insert the effect right after the three editing state declarations.
#    We anchor on `const [editingESP, setEditingESP]` because it's the last
#    of the three and easy to target uniquely.
IPSEC_EFFECT_OLD = "const [editingESP, setEditingESP] = useState<ESPGroup | null>(null)"
IPSEC_EFFECT_NEW = '''const [editingESP, setEditingESP] = useState<ESPGroup | null>(null)

  // Deep-link support for the VPN section:
  //   ?action=add                 → open the add-peer wizard on mount
  //   ?peer=<name>&action=edit    → open the edit modal for that peer
  // Used by the fleet VPN Peers page (Phase 3A) so "+ New peer" and
  // "Edit on device" land directly in the right modal instead of
  // dropping the operator on the page with a "now click Add yourself"
  // prompt.
  const [searchParams, setSearchParams] = useSearchParams()
  // We use a ref-like flag so the deep-link only triggers once per mount.
  // Without it, opening then closing the modal would re-open it on the
  // next render because the URL params are still present.
  const [deepLinkConsumed, setDeepLinkConsumed] = useState(false)'''
IPSEC_EFFECT_MARKER = "deepLinkConsumed"

# 3. Add the actual useEffect that consumes the query params. This goes
#    just before the return statement, but to keep the anchor robust we
#    anchor on the existing useQuery for peers (which we know is there)
#    via a regex below — too fragile for a string match.
#    Strategy: find the first `useQuery({` after the editingESP line and
#    insert our useEffect right before it. Implemented in the driver.
IPSEC_USEEFFECT_BLOCK = '''  // Deep-link consumer: open the right modal once the data is loaded.
  // We split this from the param-read above because the edit modal
  // needs the actual peer object (not just its name).
  // eslint-disable-next-line react-hooks/exhaustive-deps
'''
# The actual effect is appended after the peers query is in scope.
# Skipping the auto-insert for the useEffect body — instead we append a
# block right after the editingESP state declaration that combines the
# param-read AND the effect. This keeps everything in one place.

# Revised: just include the full deep-link block in IPSEC_EFFECT_NEW above
# is messy because the effect needs access to the peers query result.
# Cleaner approach: put the param-read in EFFECT_NEW (as above), then
# add the useEffect itself somewhere we can guarantee runs after the
# peer query is declared.

# To minimise risk we'll put the useEffect right before the `return (` line.
# We anchor on a known constant near the top of the render: the line
# `return (` followed by the first JSX element. Use a regex.

IPSEC_RETURN_REGEX = re.compile(r"^(  return \(\s*\n)", re.MULTILINE)
IPSEC_RETURN_REPL = '''  // Consume the deep-link params once peer data is loaded. We need the
  // peers query result to find the peer object by name for edit mode;
  // the simple ?action=add case fires as soon as we mount.
  // Imported up top: useEffect — add to the React import if not already.
  // (See the patch script: it ensures useEffect is in the react import.)
\\1'''

# We also need to add useEffect to the React import if it isn't there.
IPSEC_REACT_IMPORT_OLD = "import { useState } from 'react'"
IPSEC_REACT_IMPORT_NEW = "import { useEffect, useState } from 'react'"
IPSEC_REACT_IMPORT_MARKER = "useEffect"


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def install_new_file(src_name, dst_rel, marker):
    src = os.path.join(HERE, src_name)
    dst = os.path.join(REPO, dst_rel)
    if not os.path.exists(src):
        die(f"source file missing: {src}")
    if not os.path.exists(os.path.dirname(dst)):
        die(f"target directory missing: {os.path.dirname(dst)} (run from /opt/vyos-cp)")
    if os.path.exists(dst):
        with open(dst) as f:
            if marker in f.read():
                print(f"  · {dst_rel}: already current")
                return
        bak = dst + ".bak.vpn-peers-commit3"
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
    shutil.copy2(src, dst)
    print(f"  ✓ {dst_rel}: written")


def patch_in_place(path, old, new, marker, label):
    dst = os.path.join(REPO, path)
    if not os.path.exists(dst):
        die(f"file missing: {path}")
    with open(dst) as f:
        text = f.read()
    if marker in text:
        print(f"  · {path}: {label} already patched")
        return
    if old not in text:
        die(f"{path}: {label} anchor not found")
    bak = dst + ".bak.vpn-peers-commit3"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    with open(dst, "w") as f:
        f.write(text.replace(old, new, 1))
    print(f"  ✓ {path}: {label} patched")


def append_to_api_ts():
    """Insert VPNPeer types before `class API {`, methods before its
    closing brace at line 705 (per Phase 1 verification)."""
    dst = os.path.join(REPO, API_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {API_PATH}")
    with open(dst) as f:
        text = f.read()

    bak = dst + ".bak.vpn-peers-commit3"
    changed = False

    # Types
    if API_TYPES_MARKER in text:
        print(f"  · {API_PATH}: VPNPeer types already present")
    else:
        # Insert before `class API {`
        m = re.search(r"^class API\s*\{", text, re.MULTILINE)
        if not m:
            die(f"{API_PATH}: cannot locate 'class API {{' to insert types before")
        insert_pos = m.start()
        text = text[:insert_pos] + API_TYPES_BLOCK + text[insert_pos:]
        changed = True
        print(f"  ✓ {API_PATH}: VPNPeer types added")

    # Methods. Find the closing brace of the class. From Phase 1 we know
    # it's a bare `}` on its own line; multiple candidates exist in the
    # file (types ending in `}`). We anchor by finding the first bare
    # `}` AFTER the class declaration but BEFORE `export const api =`.
    if API_METHODS_MARKER in text:
        print(f"  · {API_PATH}: VPNPeer methods already present")
    else:
        m_class = re.search(r"^class API\s*\{", text, re.MULTILINE)
        m_export = text.find("export const api = ")
        if m_class is None or m_export < 0:
            die(f"{API_PATH}: cannot bound the API class declaration")
        # Find the last bare-line `}` between class start and export.
        # Bare-line == `\n}\n`.
        between = text[m_class.start():m_export]
        last_brace_offset = between.rfind("\n}\n")
        if last_brace_offset < 0:
            die(f"{API_PATH}: cannot find class closing brace")
        # Convert to absolute position. Insert AFTER the leading \n,
        # BEFORE the `}\n`. That way our methods become the last content
        # of the class body.
        insert_at = m_class.start() + last_brace_offset + 1  # after the \n
        text = text[:insert_at] + API_METHODS_BLOCK + text[insert_at:]
        changed = True
        print(f"  ✓ {API_PATH}: VPNPeer methods added")

    if changed:
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
        with open(dst, "w") as f:
            f.write(text)


def patch_ipsec_deep_link():
    """Add deep-link support to IPsec.tsx. Three sub-edits, applied
    surgically with idempotency checks for each."""
    dst = os.path.join(REPO, IPSEC_PATH)
    if not os.path.exists(dst):
        die(f"file missing: {IPSEC_PATH}")
    with open(dst) as f:
        text = f.read()

    bak = dst + ".bak.vpn-peers-commit3"
    changed = False

    # 1. Add useSearchParams to the react-router-dom import.
    if IPSEC_IMPORT_MARKER in text:
        print(f"  · {IPSEC_PATH}: useSearchParams already imported")
    else:
        if IPSEC_IMPORT_OLD not in text:
            die(f"{IPSEC_PATH}: cannot find react-router-dom import to extend")
        text = text.replace(IPSEC_IMPORT_OLD, IPSEC_IMPORT_NEW, 1)
        changed = True
        print(f"  ✓ {IPSEC_PATH}: useSearchParams added to react-router-dom import")

    # 2. Add useEffect to React import.
    if IPSEC_REACT_IMPORT_MARKER in text:
        print(f"  · {IPSEC_PATH}: useEffect already imported")
    else:
        if IPSEC_REACT_IMPORT_OLD not in text:
            die(f"{IPSEC_PATH}: cannot find react import to extend")
        text = text.replace(IPSEC_REACT_IMPORT_OLD, IPSEC_REACT_IMPORT_NEW, 1)
        changed = True
        print(f"  ✓ {IPSEC_PATH}: useEffect added to react import")

    # 3. Add the search-params state declaration right after editingESP.
    if IPSEC_EFFECT_MARKER in text:
        print(f"  · {IPSEC_PATH}: deep-link state already declared")
    else:
        if IPSEC_EFFECT_OLD not in text:
            die(f"{IPSEC_PATH}: cannot find editingESP state to anchor on")
        text = text.replace(IPSEC_EFFECT_OLD, IPSEC_EFFECT_NEW, 1)
        changed = True
        print(f"  ✓ {IPSEC_PATH}: deep-link state declared")

    # 4. Add the actual useEffect body right before the return (.
    EFFECT_MARKER_RUNTIME = "// Deep-link consumer: open the right modal"
    if EFFECT_MARKER_RUNTIME in text:
        print(f"  · {IPSEC_PATH}: deep-link useEffect already added")
    else:
        EFFECT_BODY = '''  // Deep-link consumer: open the right modal based on URL params.
  // Runs once per mount (gated by deepLinkConsumed) so the user can
  // close the modal without it re-opening on the next render.
  useEffect(() => {
    if (deepLinkConsumed) return
    const action = searchParams.get('action')
    const peerName = searchParams.get('peer')
    if (action === 'add') {
      setAdding(true)
      setDeepLinkConsumed(true)
      // Clean the URL so a refresh doesn't re-trigger
      const sp = new URLSearchParams(searchParams)
      sp.delete('action')
      setSearchParams(sp, { replace: true })
      return
    }
    if (action === 'edit' && peerName && peers.data) {
      const p = peers.data.find(x => x.name === peerName)
      if (p) {
        setEditingPeer(p)
        setDeepLinkConsumed(true)
        const sp = new URLSearchParams(searchParams)
        sp.delete('action')
        sp.delete('peer')
        setSearchParams(sp, { replace: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, peers.data, deepLinkConsumed])

'''
        m = IPSEC_RETURN_REGEX.search(text)
        if not m:
            die(f"{IPSEC_PATH}: cannot find 'return (' to anchor useEffect insertion")
        insert_at = m.start()
        text = text[:insert_at] + EFFECT_BODY + text[insert_at:]
        changed = True
        print(f"  ✓ {IPSEC_PATH}: deep-link useEffect inserted")

    if changed:
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
        with open(dst, "w") as f:
            f.write(text)


def main():
    print("VPN Peers — Phase 3A Commit 3 (frontend)\n")

    print("[1/4] Installing new pages")
    for src, dst, marker in NEW_FILES:
        install_new_file(src, dst, marker)

    print("\n[2/4] Wiring App.tsx (import, route, nav)")
    patch_in_place(APP_PATH, APP_IMPORT_OLD, APP_IMPORT_NEW, APP_IMPORT_MARKER,
                   "VPNPeersPage import")
    patch_in_place(APP_PATH, APP_ROUTES_OLD, APP_ROUTES_NEW, APP_ROUTES_MARKER,
                   "/vpn/peers route")
    patch_in_place(APP_PATH, APP_NAV_OLD, APP_NAV_NEW, APP_NAV_MARKER,
                   "Peers nav item")

    print("\n[3/4] Adding VPNPeer types + methods to lib/api.ts")
    append_to_api_ts()

    print("\n[4/4] Adding deep-link support to IPsec.tsx")
    patch_ipsec_deep_link()

    print()
    print("Done. Rebuild:")
    print()
    print("  docker compose down")
    print("  docker compose build --no-cache app")
    print("  docker compose up -d")
    print("  docker compose logs -f app | head -5  # wait for 'listening on :8080'")
    print()
    print("Then hard-refresh the browser. Left nav should show:")
    print("  VPN")
    print("    IKE Profiles")
    print("    ESP Profiles")
    print("    Peers  ← new")


if __name__ == "__main__":
    main()
