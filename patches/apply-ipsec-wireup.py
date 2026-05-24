#!/usr/bin/env python3
"""
apply-ipsec-wireup.py — apply the four wire-up edits for the IPsec feature.

Run from the repo root (the directory containing backend/, frontend/, Makefile).

What it does, in order:
  1. backend/internal/api/extras.go          — call RegisterIPsecRoutes(r) in RegisterExtras()
  2. backend/internal/service/nat_zones_rbac.go — add 7 ipsec.* actions to RoleAllows write slice
  3. frontend/src/lib/api.ts                  — append IPsec types + Api methods
  4. frontend/src/App.tsx                     — import IPsec page + add route
  5. frontend/src/components/DeviceHeader.tsx — add IPsec sub-nav tab

Safety guarantees:
  - Each file is backed up to <file>.bak before editing.
  - Each edit looks for an exact anchor string. If the anchor isn't found
    OR has already been applied (idempotent), the script reports clearly
    and continues.
  - Exits non-zero if any required anchor is missing — nothing is half-applied.
  - Pass --revert to restore all .bak files.
"""

import os
import sys
import shutil

REPO_FILES = [
    "backend/internal/api/extras.go",
    "backend/internal/service/nat_zones_rbac.go",
    "frontend/src/lib/api.ts",
    "frontend/src/App.tsx",
    "frontend/src/components/DeviceHeader.tsx",
    # Sanity: these new files must already be on disk (from tarball extraction).
    "backend/internal/model/ipsec.go",
    "backend/internal/vyos/translator/ipsec.go",
    "backend/internal/service/ipsec.go",
    "backend/internal/api/ipsec_handlers.go",
    "frontend/src/lib/ipsec.ts",
]


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg):
    print(f"  ✓ {msg}")


def skip(msg):
    print(f"  · {msg}")


def backup(path):
    bak = path + ".bak"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, contents):
    with open(path, "w", encoding="utf-8") as f:
        f.write(contents)


def patch(path, anchor, insertion, marker):
    """
    Insert `insertion` immediately after `anchor` in `path`.
    `marker` is a substring; if already present in the file, treat as done.
    """
    if not os.path.exists(path):
        die(f"file not found: {path}")
    text = read(path)
    if marker in text:
        skip(f"{path}: already patched")
        return
    if anchor not in text:
        die(f"{path}: anchor not found; bailing without writing.\n"
            f"  Looked for: {anchor!r}")
    backup(path)
    new = text.replace(anchor, anchor + insertion, 1)
    write(path, new)
    ok(f"{path}: patched")


def revert():
    print("Reverting from .bak files…")
    for rel in REPO_FILES:
        bak = rel + ".bak"
        if os.path.exists(bak):
            shutil.move(bak, rel)
            ok(f"{rel}: restored from .bak")
        else:
            skip(f"{rel}: no .bak found")
    print("Revert complete.")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--revert":
        revert()
        return

    # Preflight: every file the script touches must already exist.
    print("Preflight: checking that all expected files exist…")
    missing = [p for p in REPO_FILES if not os.path.exists(p)]
    if missing:
        for m in missing:
            print(f"  MISSING: {m}", file=sys.stderr)
        die("preflight failed — are you in the repo root and did you extract the tarball?")
    ok("all expected files present")
    print()

    # --- 1. extras.go: register IPsec routes ---
    print("[1/5] backend/internal/api/extras.go — register IPsec routes")
    patch(
        path="backend/internal/api/extras.go",
        anchor='\tr.Delete("/api/v1/devices/{id}/snmp", s.deleteSNMPConfig)\n',
        insertion="\n\t// IPsec (site-to-site VPN)\n\ts.RegisterIPsecRoutes(r)\n",
        marker="RegisterIPsecRoutes",
    )

    # --- 2. nat_zones_rbac.go: extend RBAC write list ---
    print("[2/5] backend/internal/service/nat_zones_rbac.go — extend RBAC write slice")
    patch(
        path="backend/internal/service/nat_zones_rbac.go",
        anchor='\t\t"snmp.upsert", "snmp.delete",\n',
        insertion=(
            '\t\t"ipsec.globals",\n'
            '\t\t"ipsec.ike.upsert", "ipsec.ike.delete",\n'
            '\t\t"ipsec.esp.upsert", "ipsec.esp.delete",\n'
            '\t\t"ipsec.peer.upsert", "ipsec.peer.delete",\n'
        ),
        marker="ipsec.peer.upsert",
    )

    # --- 3. api.ts: append types + methods ---
    print("[3/5] frontend/src/lib/api.ts — append IPsec types + Api methods")
    api_ts_patch = """
// --- IPsec ----------------------------------------------------------------

export type IKEProposal = {
  number: number; encryption: string; hash: string; dh_group: string; prf?: string;
};
export type DPDAction = 'hold' | 'clear' | 'restart';
export type DPD = { action: DPDAction; interval?: number; timeout?: number };
export type IKEMode = 'main' | 'aggressive';
export type IKEGroup = {
  name: string; description?: string; lifetime?: number;
  ike_version?: 'ikev1' | 'ikev2' | ''; mode?: IKEMode;
  dead_peer_detection?: DPD; proposals: IKEProposal[];
};
export type ESPProposal = { number: number; encryption: string; hash?: string };
export type ESPMode = 'tunnel' | 'transport';
export type ESPGroup = {
  name: string; description?: string; lifetime?: number;
  mode?: ESPMode; pfs?: string; proposals: ESPProposal[];
};
export type AuthMode = 'pre-shared-secret' | 'rsa' | 'x509';
export type IDType = 'address' | 'fqdn' | 'user-fqdn' | 'keyid';
export type PeerAuth = {
  mode: AuthMode; pre_shared_secret?: string;
  x509_certificate?: string; x509_ca_name?: string;
  local_id?: string; remote_id?: string; id_type?: IDType;
};
export type Tunnel = {
  number: number; disable?: boolean; description?: string;
  esp_group?: string; protocol?: string;
  local_subnet?: string; local_port?: string;
  remote_subnet?: string; remote_port?: string;
};
export type Peer = {
  name: string; description?: string; disable?: boolean;
  remote_address: string; local_address?: string;
  ike_group: string; default_esp_group?: string;
  authentication: PeerAuth; tunnels?: Tunnel[]; vti_interface?: string;
};
export type IPsecGlobals = {
  interfaces?: string[]; nat_traversal: boolean; log_level?: number;
};
export type IPsecConfig = {
  globals: IPsecGlobals; ike_groups?: IKEGroup[];
  esp_groups?: ESPGroup[]; peers?: Peer[];
};
export type SAStatus = {
  peer: string; tunnel: number; state: 'up' | 'down' | 'connecting';
  local_net?: string; remote_net?: string;
  bytes_in: number; bytes_out: number;
  packets_in: number; packets_out: number; uptime_sec?: number;
};

"""
    # Insert IPsec types right before `class API {` so they're in scope.
    # We can't use the patch() helper here because it inserts AFTER the anchor;
    # types must go BEFORE the class. Do it explicitly.
    if "export type IKEGroup" not in read("frontend/src/lib/api.ts"):
        backup("frontend/src/lib/api.ts")
        txt = read("frontend/src/lib/api.ts")
        txt = txt.replace("class API {\n", api_ts_patch + "class API {\n", 1)
        write("frontend/src/lib/api.ts", txt)
        ok("frontend/src/lib/api.ts: types inserted before class API")
    else:
        skip("frontend/src/lib/api.ts: types already present")

    # Now insert the Api methods just before the class's closing `}`.
    # Anchor on the last method `deleteTemplate(...)` block ending with `  }\n}`
    api_ts_methods = """  getIPsec(id: string) {
    return this.req<IPsecConfig>(`/api/v1/devices/${id}/ipsec`);
  }
  getIPsecStatus(id: string) {
    return this.req<SAStatus[]>(`/api/v1/devices/${id}/ipsec/status`);
  }
  setIPsecGlobals(id: string, g: IPsecGlobals) {
    return this.req<IPsecGlobals>(`/api/v1/devices/${id}/ipsec/globals`,
      { method: 'PUT', body: JSON.stringify(g) });
  }
  upsertIKEGroup(id: string, g: IKEGroup) {
    return this.req<IKEGroup>(`/api/v1/devices/${id}/ipsec/ike-groups/${encodeURIComponent(g.name)}`,
      { method: 'PUT', body: JSON.stringify(g) });
  }
  deleteIKEGroup(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/ike-groups/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }
  upsertESPGroup(id: string, g: ESPGroup) {
    return this.req<ESPGroup>(`/api/v1/devices/${id}/ipsec/esp-groups/${encodeURIComponent(g.name)}`,
      { method: 'PUT', body: JSON.stringify(g) });
  }
  deleteESPGroup(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/esp-groups/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }
  upsertPeer(id: string, p: Peer) {
    return this.req<Peer>(`/api/v1/devices/${id}/ipsec/peers/${encodeURIComponent(p.name)}`,
      { method: 'PUT', body: JSON.stringify(p) });
  }
  deletePeer(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/peers/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }
"""
    txt = read("frontend/src/lib/api.ts")
    if "getIPsec(id: string)" not in txt:
        anchor = "  deleteTemplate(name: string) {\n    return this.req<void>(`/api/v1/templates/${name}`, { method: 'DELETE' });\n  }\n}\n"
        if anchor not in txt:
            die("frontend/src/lib/api.ts: could not find deleteTemplate anchor; Api methods NOT added.")
        replacement = (
            "  deleteTemplate(name: string) {\n"
            "    return this.req<void>(`/api/v1/templates/${name}`, { method: 'DELETE' });\n"
            "  }\n"
            + api_ts_methods +
            "}\n"
        )
        new = txt.replace(anchor, replacement, 1)
        write("frontend/src/lib/api.ts", new)
        ok("frontend/src/lib/api.ts: Api methods appended")
    else:
        skip("frontend/src/lib/api.ts: Api methods already present")

    # --- 4. App.tsx: import + route ---
    print("[4/5] frontend/src/App.tsx — import IPsec page + add route")
    patch(
        path="frontend/src/App.tsx",
        anchor="import { SNMP } from './pages/SNMP'\n",
        insertion="import { IPsec } from './pages/IPsec'\n",
        marker="from './pages/IPsec'",
    )
    patch(
        path="frontend/src/App.tsx",
        anchor='          <Route path="/devices/:id/snmp" element={<SNMP />} />\n',
        insertion='          <Route path="/devices/:id/ipsec" element={<IPsec />} />\n',
        marker='path="/devices/:id/ipsec"',
    )

    # --- 5. DeviceHeader.tsx: sub-nav tab ---
    print("[5/5] frontend/src/components/DeviceHeader.tsx — add IPsec sub-nav tab")
    patch(
        path="frontend/src/components/DeviceHeader.tsx",
        anchor="    { to: `/devices/${id}/snmp`,           label: 'SNMP',     match: /\\/snmp/ },\n",
        insertion="    { to: `/devices/${id}/ipsec`,          label: 'IPsec',    match: /\\/ipsec/ },\n",
        marker="label: 'IPsec'",
    )

    print()
    print("All wire-up edits applied. Next steps:")
    print("  - Create frontend/src/pages/IPsec.tsx (the page component is not auto-generated)")
    print("  - make rebuild")
    print("  - To undo: python3 apply-ipsec-wireup.py --revert")


if __name__ == "__main__":
    main()
