#!/usr/bin/env python3
"""
patch-psk-redaction.py — redact pre-shared secrets from the audit log.

What this changes:
  1. backend/internal/vyos/translator/ipsec.go
     Adds RedactSecrets(ops) that walks []ConfigureOp and rewrites the
     value of any 'authentication psk <name> secret' op to "***REDACTED***".
  2. backend/internal/service/nat_zones_rbac.go
     Adds runConfigureRedacted(...) — same as runConfigure but takes a
     separate auditOps slice. Device gets the real ops; audit gets the
     redacted ones.
  3. backend/internal/service/ipsec.go
     UpsertPeer now calls runConfigureRedacted with the redacted ops
     instead of runConfigure.

Run from /opt/vyos-cp. Idempotent.
"""
import os
import shutil
import sys

# ---------------------------------------------------------------------------
# Edit 1: RedactSecrets helper in the translator
# ---------------------------------------------------------------------------

TRANSLATOR_PATH = "backend/internal/vyos/translator/ipsec.go"

REDACT_HELPER = '''// RedactSecrets returns a copy of ops with any pre-shared secret value
// replaced by a fixed sentinel string. The original slice is not modified.
//
// Used by the service layer: the device receives the real ops via
// /configure, but the audit log persists the redacted copy. A DB dump of
// the audit table cannot recover a PSK.
//
// Today this only covers `vpn ipsec authentication psk <name> secret`.
// If future code paths emit other secret leaves (RSA private keys,
// pre-1.5 inline PSKs, AAA passwords), extend the path-match here.
func RedactSecrets(ops []vyos.ConfigureOp) []vyos.ConfigureOp {
\tout := make([]vyos.ConfigureOp, len(ops))
\tfor i, o := range ops {
\t\tout[i] = o
\t\tif isPSKSecretPath(o.Path) {
\t\t\tout[i].Value = "***REDACTED***"
\t\t}
\t}
\treturn out
}

// isPSKSecretPath reports whether path is exactly
// [vpn ipsec authentication psk <name> secret].
func isPSKSecretPath(path []string) bool {
\treturn len(path) == 6 &&
\t\tpath[0] == "vpn" && path[1] == "ipsec" &&
\t\tpath[2] == "authentication" && path[3] == "psk" &&
\t\tpath[5] == "secret"
}

'''

# Anchor: insert RedactSecrets immediately before DecodeIPsec so it's grouped
# with the other public helpers, not buried at the end of the file.
TRANSLATOR_ANCHOR = "// --- Decode: VyOS JSON → domain --------------------------------------------"
TRANSLATOR_MARKER = "func RedactSecrets("


# ---------------------------------------------------------------------------
# Edit 2: runConfigureRedacted variant in service/nat_zones_rbac.go
# ---------------------------------------------------------------------------

RBAC_PATH = "backend/internal/service/nat_zones_rbac.go"

RBAC_ADDITION = '''// runConfigureRedacted is runConfigure's secret-aware sibling. The device
// receives `ops` unchanged; the audit log receives `auditOps`. Callers that
// emit secrets (e.g. IPsec UpsertPeer with a PSK) produce auditOps via
// translator.RedactSecrets so secrets never reach the audit table.
//
// Splitting at the runConfigure boundary keeps redaction out of the device
// path entirely — there is no code path where audit-only ops can leak to
// VyOS and no path where unredacted ops can reach the audit table.
func (s *Service) runConfigureRedacted(ctx context.Context, client *vyos.Client,
\tuserID, userName, deviceID, action string,
\tops, auditOps []vyos.ConfigureOp) error {

\tdev, _ := s.store.GetDevice(ctx, deviceID)
\tdevName := ""
\tif dev != nil {
\t\tdevName = dev.Name
\t}
\terr := client.Configure(ctx, ops, CommitConfirmMinutes)
\tif err == nil && CommitConfirmMinutes > 0 {
\t\tif confirmErr := client.Confirm(ctx); confirmErr != nil {
\t\t\terr = fmt.Errorf("commit-confirm failed, changes reverted: %w", confirmErr)
\t\t} else {
\t\t\t_ = client.Save(ctx)
\t\t}
\t}
\terrMsg := ""
\tif err != nil {
\t\terrMsg = err.Error()
\t}
\t_ = s.audit(ctx, userID, userName, deviceID, devName, action, toModelOps(auditOps), err == nil, errMsg)
\treturn err
}

'''

RBAC_ANCHOR = "// --- RBAC helpers ----------------------------------------------------------"
RBAC_MARKER = "func (s *Service) runConfigureRedacted("


# ---------------------------------------------------------------------------
# Edit 3: UpsertPeer in service/ipsec.go uses the redacted variant
# ---------------------------------------------------------------------------

SERVICE_PATH = "backend/internal/service/ipsec.go"

UPSERT_OLD = '''	newOps, err := translator.PeerOps(p)
	if err != nil {
		return err
	}
	ops := append(translator.DeletePeerOps(p.Name), newOps...)
	return s.runConfigure(ctx, client, userID, userName, deviceID, "ipsec.peer.upsert", redactPSK(ops))
}'''

UPSERT_NEW = '''	newOps, err := translator.PeerOps(p)
	if err != nil {
		return err
	}
	ops := append(translator.DeletePeerOps(p.Name), newOps...)
	// PSK redaction: device gets ops; audit gets a redacted copy so the
	// pre-shared secret never lands in audit_log.ops[].
	auditOps := translator.RedactSecrets(ops)
	return s.runConfigureRedacted(ctx, client, userID, userName, deviceID, "ipsec.peer.upsert", ops, auditOps)
}'''

UPSERT_MARKER = "translator.RedactSecrets(ops)"


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def patch_file(path, anchor, insertion, marker, *, before=True):
    if not os.path.exists(path):
        die(f"file not found: {path} (run from /opt/vyos-cp)")
    with open(path, "r") as f:
        text = f.read()
    if marker in text:
        print(f"  · {path}: already patched (marker present)")
        return
    if anchor not in text:
        die(f"{path}: anchor not found — bailing.\n  Looked for: {anchor[:80]}…")
    bak = path + ".bak.psk-redaction"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    if before:
        new = text.replace(anchor, insertion + anchor, 1)
    else:
        new = text.replace(anchor, anchor + insertion, 1)
    with open(path, "w") as f:
        f.write(new)
    print(f"  ✓ {path}: patched")


def replace_block(path, old, new, marker):
    if not os.path.exists(path):
        die(f"file not found: {path}")
    with open(path, "r") as f:
        text = f.read()
    if marker in text:
        print(f"  · {path}: already patched (marker present)")
        return
    if old not in text:
        die(f"{path}: target block not found.\n  Looked for: {old[:80]}…")
    bak = path + ".bak.psk-redaction"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = text.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(text)
    print(f"  ✓ {path}: patched")


def main():
    print("Patching PSK redaction for audit log…\n")

    print("[1/3] Adding RedactSecrets() to translator/ipsec.go")
    patch_file(TRANSLATOR_PATH, TRANSLATOR_ANCHOR, REDACT_HELPER, TRANSLATOR_MARKER, before=True)

    print("[2/3] Adding runConfigureRedacted() to service/nat_zones_rbac.go")
    patch_file(RBAC_PATH, RBAC_ANCHOR, RBAC_ADDITION, RBAC_MARKER, before=True)

    print("[3/3] Switching UpsertPeer to use the redacted variant")
    replace_block(SERVICE_PATH, UPSERT_OLD, UPSERT_NEW, UPSERT_MARKER)

    print()
    print("Done. Next: docker compose down && docker compose build --no-cache app && docker compose up -d")
    print()
    print("To verify:")
    print("  1. Recreate the peer through the wizard")
    print("  2. Open Audit log in the UI")
    print("  3. Expand the ipsec.peer.upsert row — the 'secret' op's value should show '***REDACTED***'")


if __name__ == "__main__":
    main()
