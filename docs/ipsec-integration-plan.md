# IPsec VPN integration — vyos-cp

A site-to-site IPsec feature that fits the existing architecture without bending it. Same end-to-end shape as NAT, Zones, QoS, SNMP: **model → translator → service → API → frontend**, with commit-confirm and audit on every device write.

## Audit of what already exists

| Layer | Present today | Touch point for IPsec |
|---|---|---|
| `backend/internal/vyos/client.go` | Generic VyOS HTTP client (Configure / Retrieve / Show / Save) | Reused as-is — no new client methods needed |
| `backend/internal/model/` | `model.go`, `nat_zones.go`, `interface.go`, `qos.go`, `snmp.go` | **New file** `ipsec.go` |
| `backend/internal/vyos/translator/` | `translator.go`, `nat_zones.go`, `qos.go`, `snmp.go` | **New file** `ipsec.go` |
| `backend/internal/service/` | `service.go` + `nat_zones_rbac.go` + `qos_snmp.go` (with `runConfigure` helper) | **New file** `ipsec.go` |
| `backend/internal/api/server.go` + `extras.go` | All routes registered in `RegisterExtras()` | Insert new route block; new handlers in a new file |
| `backend/internal/service/nat_zones_rbac.go::RoleAllows` | RBAC write-action allowlist | Append IPsec write actions to the `write` slice |
| `frontend/src/lib/api.ts` | Typed fetch client with NAT/Zones/QoS methods | Append IPsec types + API methods |
| `frontend/src/pages/` | One page per device feature (NAT.tsx, Zones.tsx, QoS.tsx, SNMP.tsx) | **New page** `IPsec.tsx` |
| `frontend/src/App.tsx` route table | Per-feature `<Route>` under `/devices/:id/...` | Add `/devices/:id/ipsec` |
| `frontend/src/components/DeviceHeader.tsx` | Device sub-nav tabs (Firewall / Zones / NAT / QoS / SNMP) | Add IPsec tab |

The existing edge-case handling carries over for free: the translator unwraps VyOS 1.5 retrieve responses through the same helpers, `runConfigure` already does atomic apply + commit-confirm + Save + audit, and the WebSocket hub fans out per-device events without IPsec needing to know about it.

## VyOS configuration model

VyOS exposes IPsec under `vpn ipsec`. The minimum tree needed for a usable site-to-site v1:

```
vpn ipsec
├── ipsec-interfaces interface <if>
├── nat-traversal <enable|disable>
├── logging log-level <0..5>
├── ike-group <name>
│   ├── key-exchange <ikev1|ikev2>
│   ├── lifetime <sec>
│   ├── mode <main|aggressive>           # IKEv1 only
│   ├── dead-peer-detection { action interval timeout }
│   └── proposal <N> { encryption hash dh-group prf }
├── esp-group <name>
│   ├── lifetime <sec>
│   ├── mode <tunnel|transport>
│   ├── pfs <enable|disable|dh-groupN>
│   └── proposal <N> { encryption hash }
└── site-to-site peer <peer-id>
    ├── remote-address <ip|fqdn|any>
    ├── local-address <ip|any>
    ├── ike-group <ref>
    ├── default-esp-group <ref>
    ├── authentication { mode pre-shared-secret <psk> ... }
    └── tunnel <N> { local prefix ... remote prefix ... esp-group <ref> ... }
```

The model file (`backend/internal/model/ipsec.go`) maps each of those onto one Go struct. References (peer.ike_group → IKEGroup.Name, tunnel.esp_group → ESPGroup.Name) are string names, validated by the translator before any write.

## End-to-end flow for "save a peer" (mirrors the rule-write lifecycle)

| # | Layer | Action |
|---|---|---|
| 1 | UI | `IPsec.tsx` PUTs `/api/v1/devices/{id}/ipsec/peers/{name}` with a `Peer` JSON body |
| 2 | Router | chi accepts; `authMW` validates the JWT and injects user identity |
| 3 | RBAC | `s.requireRole(w, r, "ipsec.peer.upsert")` rejects viewers with 403 |
| 4 | Service | `service.UpsertPeer` calls `translator.PeerOps(p)` for the new state and `translator.DeletePeerOps(p.Name)` for atomic replace; concatenates into one `[]ConfigureOp` |
| 5 | Pool | `clients.Get(deviceID)` returns the cached `*vyos.Client`, unsealing the device API key on first use |
| 6 | VyOS | `client.Configure(ctx, ops, CommitConfirmMinutes)` — single atomic `/configure` call. If the operator's reachability breaks (a self-inflicted lockout), VyOS auto-rolls back after the confirm window |
| 7 | Audit | `store.RecordAudit` writes `actor + device + ops[] + success/failure` — with the PSK redacted from the persisted ops (see security section) |
| 8 | Push | WebSocket hub broadcasts `ipsec-updated` to subscribed UI tabs |

This is the same eight-step path that the engineering handout describes for rule writes, just with new translator inputs.

## Files to add or change

Scaffold files generated alongside this plan are drop-in starting points — they compile against the existing module path `github.com/vyos-cp/vyos-cp/...` and follow the project's naming/style conventions.

**New files**
- `backend/internal/model/ipsec.go` — domain types (IKEGroup, ESPGroup, Peer, Tunnel, IPsecGlobals, IPsecConfig, SAStatus)
- `backend/internal/vyos/translator/ipsec.go` — encode + decode, modeled on `translator/nat_zones.go`
- `backend/internal/service/ipsec.go` — `GetIPsecConfig`, `UpsertIKEGroup` / `DeleteIKEGroup`, `UpsertESPGroup` / `DeleteESPGroup`, `UpsertPeer` / `DeletePeer`, `SetIPsecGlobals`, `GetIPsecStatus`
- `backend/internal/api/ipsec_handlers.go` — handlers + `RegisterIPsecRoutes(r chi.Router)`
- `backend/internal/vyos/parse/ipsec.go` *(deferred)* — text parser for `show vpn ipsec sa` op-mode output, modeled on `parse/firewall.go`
- `frontend/src/lib/ipsec.ts` *(or merge into `api.ts`)* — TypeScript types + API methods
- `frontend/src/pages/IPsec.tsx` — three-section page: IKE groups list, ESP groups list, peers list, plus a live SA-status panel

**Edits**
- `backend/internal/api/extras.go::RegisterExtras` — one line: `s.RegisterIPsecRoutes(r)`
- `backend/internal/service/nat_zones_rbac.go::RoleAllows` — append the seven IPsec write actions (`ipsec.globals`, `ipsec.ike.upsert/delete`, `ipsec.esp.upsert/delete`, `ipsec.peer.upsert/delete`) to the `write` slice so operators (not just admins) can mutate IPsec
- `frontend/src/App.tsx` — add `<Route path="/devices/:id/ipsec" element={<IPsec />} />`
- `frontend/src/components/DeviceHeader.tsx` — add an `IPsec` tab to the device sub-nav array
- `frontend/src/lib/api.ts` — add the IPsec types and `Api` methods (the patch is sketched in the comment block of `ipsec.ts`)
- `docs/vyos-setup.md` — note the per-device enablement commands (`set vpn ipsec ipsec-interfaces interface ethX` if pre-1.4 behavior is needed)

No database migration is required for v1: IPsec config lives entirely on the device. If we want server-side IPsec templates analogous to `rule_set_templates`, that's a follow-up migration adding an `ipsec_templates` table — same shape, no model changes.

## Security model — three places that need care

1. **Pre-shared keys (PSKs)** — the most sensitive new data path. The API accepts a PSK on PUT in cleartext (over TLS); the service forwards it to the device via `/configure`; the translator must never put the PSK back into anything that gets persisted server-side. Two safeguards in the scaffold:
   - `GetIPsecConfig` rewrites any decoded `pre_shared_secret` to the sentinel `"(stored)"` before returning to the UI, so a leak in the device retrieve path can't surface a key.
   - The audit row's `ops[]` must redact the PSK before persistence. **Action required**: extend `runConfigure` in `nat_zones_rbac.go` to accept an optional `auditOps []vyos.ConfigureOp` distinct from the ops sent to the device, and pass a PSK-redacted copy from `UpsertPeer`. The scaffold marks the spot with a `redactPSK` placeholder and a `TODO`; this is a small but blocking change before merging the feature.
2. **Commit-confirm is non-negotiable for peer writes** — a bad IKE proposal or wrong local-address can sever the very tunnel a remote operator is depending on. `runConfigure` already passes `CommitConfirmMinutes` on every call, so this is free; just don't ship a code path that calls `client.Configure` directly without going through `runConfigure`.
3. **RBAC entries** — every new action string must be in `RoleAllows`'s `write` slice or operators will silently be denied. Forgetting one is the most common failure mode when adding a feature (verified against the existing entries for `nat.upsert`, `zone.upsert`, `qos.upsert`, `snmp.upsert`).

## Edge cases to handle (in roughly this order)

- **VyOS 1.5 retrieve wrapping.** The decoder handles bare bodies; if `client.Retrieve(["vpn","ipsec"])` returns a 1.5-rolling style `{"ipsec": {...}}`, unwrap one level before `DecodeIPsec` — same pattern as `ListRuleSets`.
- **Reference integrity.** When deleting an IKE/ESP group, `vyos commit` will reject if a peer still references it. The service can pre-flight by walking the decoded `IPsecConfig` and returning a 409 with the referencing peer names — much friendlier than the bare VyOS error.
- **Empty proposals.** Both `IKEGroupOps` and `ESPGroupOps` reject zero-proposal groups; the UI should enforce the same.
- **PSK round-trip preservation.** When an operator edits a peer without re-entering the PSK, the UI sends `"(stored)"`. The service must detect that sentinel and **either** fetch the existing PSK from the device before the delete-then-set roundtrip wipes it, **or** require the operator to re-enter the PSK. The scaffold takes the second (safer) path; the first is the right production behavior.
- **AEAD ciphers** (e.g. `aes128gcm128`) — VyOS rejects a `hash` value on AEAD proposals. The encoder skips `hash` when it's empty; the UI should hide the hash field when an AEAD encryption is selected.
- **NAT-T default.** Most real deployments need NAT-T enabled. The `SetIPsecGlobals` path always writes the leaf (delete+set), so a single click in the UI flips it deterministically without committing the rest of the IPsec tree.

## Implementation order

1. **Model + translator + translator tests** (1–2 days). Pure data work; can be done without touching VyOS. Mirror `translator_test.go`'s roundtrip pattern: encode → simulate VyOS-shaped JSON → decode → assert equality.
2. **Service + handlers + RBAC entries + audit redaction** (1 day). All wiring; no UI yet. Tested via curl against a VyOS 1.4 lab device.
3. **Frontend page (read-only first)** (1 day). Read the IPsec config and render IKE/ESP/peer tables. No edit yet — exposes the round-trip and surfaces decode bugs cheaply.
4. **Frontend forms** (2–3 days). Editable IKE/ESP groups and peers with tunnels. The IKE/ESP forms are easy; the peer form is the largest piece because of the tunnel sub-list and the auth-mode-dependent fields.
5. **`show vpn ipsec sa` parser + live status panel** (1 day). Modeled on `parse/firewall.go`. Read-only, no commit path.
6. **Documentation** (half-day). Update `docs/vyos-setup.md` and the engineering reference to list the new endpoints and the seven new audit action strings.

Total estimate: roughly one focused engineering week. No deployment topology changes, no new dependencies, no new containers, no database migration in v1.

## Out of scope for v1 (note in the roadmap)

- PKI / x509 cert provisioning UI. The translator handles `authentication mode x509` and writes the cert/CA references, but uploading certs to the device's `pki` tree is a separate feature.
- Mobile IPsec / IKEv2 EAP / road-warrior pool. Different VyOS tree (`vpn ipsec remote-access`), worth its own page.
- VTI-based routed IPsec. The peer model has a `vti_interface` field for forward compatibility, but the v1 UI focuses on the policy-based `tunnel { local/remote }` form.
- Fleet-wide IPsec templates (analogous to `rule_set_templates`). Adds an `ipsec_templates` table; mechanical follow-up once the per-device feature is solid.
