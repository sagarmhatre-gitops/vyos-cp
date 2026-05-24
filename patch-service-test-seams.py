#!/usr/bin/env python3
"""
patch-service-test-seams.py — introduce interfaces so the service layer
can be unit-tested without a real VyOS device.

What this changes:

1. backend/internal/service/interfaces.go (new file)
     Defines vyosClient + clientPool interfaces, plus a clientPoolAdapter
     that lets the real *ClientPool satisfy clientPool.

2. backend/internal/service/service.go
     Service struct gets a new `cp clientPool` field. New() wraps the
     real *ClientPool in an adapter so cp == adapter(clients). Both
     fields are preserved so the existing `GetClient(...) *vyos.Client`
     (used by the poller) keeps working.

3. All `s.clients.Get(...)` call sites switched to `s.cp.Get(...)`.
     The Go compiler infers the local variable type as the interface
     (vyosClient) — no other code changes needed at the call sites.

   Call sites in:
     - service.go
     - ipsec.go
     - nat_zones_rbac.go
     - qos_snmp.go
     - interfaces_groups.go
     - completeness.go
     - quick_actions.go
     - fleet_health.go
     - search.go
     - overview.go
     - metrics.go

   The two `s.clients.Invalidate(...)` calls stay on `s.clients` —
   Invalidate isn't in the interface (tests don't need it).

4. backend/internal/service/ipsec_service_test.go (new file)
     Service-level tests covering the exact regressions this thread hit:
     atomic op composition, PSK redaction, PSK preservation on edit,
     delete behavior, tunnel batching.

Idempotent. Run from /opt/vyos-cp. Expects interfaces.go and
ipsec_service_test.go alongside this script.
"""
import os
import re
import shutil
import sys

REPO = os.getcwd()
HERE = os.path.dirname(os.path.abspath(__file__))

# Files to drop in wholesale (new files).
NEW_FILES = [
    ("interfaces.go",          "backend/internal/service/interfaces.go",          "vyosClient is the slice"),
    ("ipsec_service_test.go",  "backend/internal/service/ipsec_service_test.go",  "TestUpsertPeer_AtomicOpsReachDevice"),
]

# In-place edit: Service struct + New() constructor.
SERVICE_GO = "backend/internal/service/service.go"

STRUCT_OLD = '''type Service struct {
\tstore   *store.Store
\tclients *ClientPool
}

func New(s *store.Store) *Service {
\treturn &Service{store: s, clients: NewClientPool(s)}
}'''

STRUCT_NEW = '''type Service struct {
\tstore *store.Store
\t// clients is the concrete pool — kept for GetClient() (used by the
\t// poller, which needs the real *vyos.Client) and for Invalidate.
\tclients *ClientPool
\t// cp is the interface-typed view of the same pool, used by every
\t// service method that we want to be unit-testable without a real
\t// VyOS device. See interfaces.go for the rationale.
\tcp clientPool
\t// auditFn and getDeviceFn are seams for testing — they default to
\t// the real audit / device-lookup paths, but tests can override them
\t// to avoid needing a real *store.Store. Production code should not
\t// set these directly; they are populated by New().
\tauditFn     auditFunc
\tgetDeviceFn getDeviceFunc
}

// auditFunc and getDeviceFunc abstract just the two store interactions
// that the configure-flow needs. Other methods still talk to s.store
// directly (CreateDevice, ListAudit, etc.) because they're not on the
// per-write hot path that tests need to fake out.
type auditFunc func(ctx context.Context, userID, userName, deviceID, deviceName, action string,
\tops []model.ConfigureOp, success bool, errMsg string) error

type getDeviceFunc func(ctx context.Context, deviceID string) (*model.Device, error)

func New(s *store.Store) *Service {
\tpool := NewClientPool(s)
\tsvc := &Service{
\t\tstore:   s,
\t\tclients: pool,
\t\tcp:      &clientPoolAdapter{pool: pool},
\t}
\t// Default seams point at the real store. Tests substitute their own.
\tsvc.auditFn = svc.audit
\tsvc.getDeviceFn = s.GetDevice
\treturn svc
}'''

STRUCT_MARKER = "auditFn     auditFunc"


# Patch runConfigure: accept vyosClient instead of *vyos.Client, and
# route audit/device-lookup through the seam functions.
RUN_CONFIGURE_OLD = '''// runConfigure is the shared commit+confirm+save+audit flow.
func (s *Service) runConfigure(ctx context.Context, client *vyos.Client,
\tuserID, userName, deviceID, action string, ops []vyos.ConfigureOp) error {

\tdev, _ := s.store.GetDevice(ctx, deviceID)
\tdevName := ""
\tif dev != nil {
\t\tdevName = dev.Name
\t}
\terr := client.Configure(ctx, ops, CommitConfirmMinutes)
\tif err == nil && CommitConfirmMinutes > 0 {
\t\tif confirmErr := client.Confirm(ctx); confirmErr != nil {
\t\t\t// If confirm fails the commit will revert — surface that as an error.
\t\t\terr = fmt.Errorf("commit-confirm failed, changes reverted: %w", confirmErr)
\t\t} else {
\t\t\t_ = client.Save(ctx)
\t\t}
\t}
\terrMsg := ""
\tif err != nil {
\t\terrMsg = err.Error()
\t}
\t_ = s.audit(ctx, userID, userName, deviceID, devName, action, toModelOps(ops), err == nil, errMsg)
\treturn err
}'''

RUN_CONFIGURE_NEW = '''// runConfigure is the shared commit+confirm+save+audit flow.
// The `client` parameter accepts the vyosClient interface so tests can
// inject a fake. In production, *vyos.Client satisfies the interface.
func (s *Service) runConfigure(ctx context.Context, client vyosClient,
\tuserID, userName, deviceID, action string, ops []vyos.ConfigureOp) error {

\tdev, _ := s.getDeviceFn(ctx, deviceID)
\tdevName := ""
\tif dev != nil {
\t\tdevName = dev.Name
\t}
\terr := client.Configure(ctx, ops, CommitConfirmMinutes)
\tif err == nil && CommitConfirmMinutes > 0 {
\t\tif confirmErr := client.Confirm(ctx); confirmErr != nil {
\t\t\t// If confirm fails the commit will revert — surface that as an error.
\t\t\terr = fmt.Errorf("commit-confirm failed, changes reverted: %w", confirmErr)
\t\t} else {
\t\t\t_ = client.Save(ctx)
\t\t}
\t}
\terrMsg := ""
\tif err != nil {
\t\terrMsg = err.Error()
\t}
\t_ = s.auditFn(ctx, userID, userName, deviceID, devName, action, toModelOps(ops), err == nil, errMsg)
\treturn err
}'''

RUN_CONFIGURE_MARKER = "client vyosClient,\n\tuserID, userName, deviceID, action string, ops []vyos.ConfigureOp) error"


# Same surgery on runConfigureRedacted.
RUN_REDACTED_OLD = '''func (s *Service) runConfigureRedacted(ctx context.Context, client *vyos.Client,
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
}'''

RUN_REDACTED_NEW = '''func (s *Service) runConfigureRedacted(ctx context.Context, client vyosClient,
\tuserID, userName, deviceID, action string,
\tops, auditOps []vyos.ConfigureOp) error {

\tdev, _ := s.getDeviceFn(ctx, deviceID)
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
\t_ = s.auditFn(ctx, userID, userName, deviceID, devName, action, toModelOps(auditOps), err == nil, errMsg)
\treturn err
}'''

RUN_REDACTED_MARKER = "client vyosClient,\n\tuserID, userName, deviceID, action string,\n\tops, auditOps []vyos.ConfigureOp) error"


# Widen 5 internal helper functions from *vyos.Client → vyosClient.
# These functions only use methods that are in the interface
# (Retrieve, Show), so the change is safe. They are called from service
# methods where `client` is now the interface type — without this change,
# the callers fail to compile.
HELPER_WIDENINGS = [
    # (file, old signature snippet, new signature snippet)
    ("backend/internal/service/ipsec.go",
     "func (s *Service) fetchExistingPSK(ctx context.Context, client *vyos.Client, peerName string) (string, error) {",
     "func (s *Service) fetchExistingPSK(ctx context.Context, client vyosClient, peerName string) (string, error) {"),
    ("backend/internal/service/qos_snmp.go",
     "func (s *Service) kernelIFBNames(ctx context.Context, client *vyos.Client) ([]string, error) {",
     "func (s *Service) kernelIFBNames(ctx context.Context, client vyosClient) ([]string, error) {"),
    ("backend/internal/service/qos_snmp.go",
     "func (s *Service) usedIFBNames(ctx context.Context, client *vyos.Client) (map[string]bool, error) {",
     "func (s *Service) usedIFBNames(ctx context.Context, client vyosClient) (map[string]bool, error) {"),
    ("backend/internal/service/qos_snmp.go",
     "func (s *Service) findRedirectorOf(ctx context.Context, client *vyos.Client, ifb string) (string, string, error) {",
     "func (s *Service) findRedirectorOf(ctx context.Context, client vyosClient, ifb string) (string, string, error) {"),
    ("backend/internal/service/qos_snmp.go",
     "func (s *Service) lookupRedirectTarget(ctx context.Context, client *vyos.Client, iface, kind string) (string, error) {",
     "func (s *Service) lookupRedirectTarget(ctx context.Context, client vyosClient, iface, kind string) (string, error) {"),
]


def widen_helpers():
    """Widen internal helpers from *vyos.Client → vyosClient.

    The helpers only use methods that are in the vyosClient interface,
    so widening is safe. Without this, the call sites where `client` is
    now vyosClient (from s.cp.Get) fail to compile.
    """
    total = 0
    for path, old, new in HELPER_WIDENINGS:
        full = os.path.join(REPO, path)
        if not os.path.exists(full):
            die(f"file missing: {path}")
        with open(full) as f:
            text = f.read()
        if new in text:
            print(f"  · {path}: helper already widened")
            continue
        if old not in text:
            die(f"{path}: helper signature not found:\n  {old[:80]}")
        bak = full + ".bak.test-seams"
        if not os.path.exists(bak):
            shutil.copy2(full, bak)
        with open(full, "w") as f:
            f.write(text.replace(old, new, 1))
        print(f"  ✓ {path}: widened {old.split('(')[0].split()[-1]}")
        total += 1
    print(f"  → {total} helper signature(s) widened")


# Files where every `s.clients.Get` is rewritten to `s.cp.Get`.
# Invalidate calls and GetClient() are not in this list.
CALL_SITE_FILES = [
    "backend/internal/service/service.go",
    "backend/internal/service/ipsec.go",
    "backend/internal/service/nat_zones_rbac.go",
    "backend/internal/service/qos_snmp.go",
    "backend/internal/service/interfaces_groups.go",
    "backend/internal/service/completeness.go",
    "backend/internal/service/quick_actions.go",
    "backend/internal/service/fleet_health.go",
    "backend/internal/service/search.go",
    "backend/internal/service/overview.go",
    "backend/internal/service/metrics.go",
]


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
            cur = f.read()
        if marker in cur:
            print(f"  · {dst_rel}: already current")
            return
        bak = dst + ".bak.test-seams"
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
    shutil.copy2(src, dst)
    print(f"  ✓ {dst_rel}: written")


def patch_struct():
    dst = os.path.join(REPO, SERVICE_GO)
    if not os.path.exists(dst):
        die(f"file missing: {SERVICE_GO}")
    with open(dst) as f:
        text = f.read()
    if STRUCT_MARKER in text:
        print(f"  · {SERVICE_GO}: struct already patched")
        return
    if STRUCT_OLD not in text:
        die(f"{SERVICE_GO}: Service struct anchor not found (file already modified?)")
    bak = dst + ".bak.test-seams"
    if not os.path.exists(bak):
        shutil.copy2(dst, bak)
    with open(dst, "w") as f:
        f.write(text.replace(STRUCT_OLD, STRUCT_NEW, 1))
    print(f"  ✓ {SERVICE_GO}: Service struct patched")


def rewrite_call_sites():
    # Replace `s.clients.Get(` with `s.cp.Get(` everywhere it appears.
    # Leaves `s.clients.Invalidate` and `s.clients.` access for non-Get
    # methods alone. Idempotent — running twice does nothing the second
    # time because there will be no remaining `s.clients.Get(` after the
    # first pass.
    pattern = re.compile(r"\bs\.clients\.Get\(")
    total = 0
    for path in CALL_SITE_FILES:
        full = os.path.join(REPO, path)
        if not os.path.exists(full):
            print(f"  · {path}: not present, skipping")
            continue
        with open(full) as f:
            text = f.read()
        if not pattern.search(text):
            print(f"  · {path}: no s.clients.Get() calls (already migrated or never had any)")
            continue
        bak = full + ".bak.test-seams"
        if not os.path.exists(bak):
            shutil.copy2(full, bak)
        new_text, n = pattern.subn("s.cp.Get(", text)
        with open(full, "w") as f:
            f.write(new_text)
        print(f"  ✓ {path}: {n} call site(s) migrated to s.cp.Get(")
        total += n
    print(f"  → {total} call site(s) total")


def patch_run_configure():
    """Patch both runConfigure variants to use vyosClient + auditFn + getDeviceFn."""
    rbac_path = os.path.join(REPO, "backend/internal/service/nat_zones_rbac.go")
    if not os.path.exists(rbac_path):
        die(f"file missing: {rbac_path}")
    with open(rbac_path) as f:
        text = f.read()

    # runConfigure (no-redaction)
    if RUN_CONFIGURE_MARKER in text:
        print(f"  · runConfigure: already patched")
    elif RUN_CONFIGURE_OLD in text:
        bak = rbac_path + ".bak.test-seams"
        if not os.path.exists(bak):
            shutil.copy2(rbac_path, bak)
        text = text.replace(RUN_CONFIGURE_OLD, RUN_CONFIGURE_NEW, 1)
        with open(rbac_path, "w") as f:
            f.write(text)
        print(f"  ✓ runConfigure: refactored to vyosClient + auditFn + getDeviceFn")
    else:
        die(f"runConfigure anchor not found — has nat_zones_rbac.go been modified outside this patch chain?")

    # runConfigureRedacted — re-read in case we just wrote.
    with open(rbac_path) as f:
        text = f.read()
    if RUN_REDACTED_MARKER in text:
        print(f"  · runConfigureRedacted: already patched")
    elif RUN_REDACTED_OLD in text:
        text = text.replace(RUN_REDACTED_OLD, RUN_REDACTED_NEW, 1)
        with open(rbac_path, "w") as f:
            f.write(text)
        print(f"  ✓ runConfigureRedacted: refactored to vyosClient + auditFn + getDeviceFn")
    else:
        die(f"runConfigureRedacted anchor not found (the psk-redaction patch should have added it)")


def main():
    print("Adding service-layer test seams…\n")

    print("[1/5] Installing new files (interfaces.go + test file)")
    for src, dst, marker in NEW_FILES:
        install_new_file(src, dst, marker)

    print("\n[2/5] Patching Service struct + New() constructor")
    patch_struct()

    print("\n[3/5] Refactoring runConfigure + runConfigureRedacted")
    patch_run_configure()

    print("\n[4/5] Migrating s.clients.Get(...) → s.cp.Get(...) across service package")
    rewrite_call_sites()

    print("\n[5/5] Widening internal helpers from *vyos.Client → vyosClient")
    widen_helpers()

    print()
    print("Done. Backend changed — run tests + clean rebuild:")
    print()
    print("  # 1. Tests (will fail clearly if the refactor broke anything)")
    print("  docker run --rm -v \"$PWD/backend:/src\" -w /src golang:1.22-alpine \\")
    print("    go test ./internal/service/")
    print()
    print("  # 2. Full rebuild")
    print("  docker compose down")
    print("  docker compose build --no-cache app")
    print("  docker compose up -d")


if __name__ == "__main__":
    main()
