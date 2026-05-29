#!/usr/bin/env python3
"""
vyos-cp — Rule Simulation Frontend Deployment (automated)

Copies the React component + CSS, patches api.ts with three new methods,
mounts the panel in RuleSetEditor.tsx, then builds and rebuilds the stack.

Every file edit is backed up first (.bak.sim-<timestamp>). If any anchor
needed for a patch is missing, the script aborts BEFORE writing — it never
corrupts a file on a failed match.

Usage:
    python3 deploy_frontend.py --src /home/ubuntu --target /opt/vyos-cp
    python3 deploy_frontend.py --dry-run        # show plan, touch nothing
    python3 deploy_frontend.py --no-build       # patch only, skip make
    python3 deploy_frontend.py --rollback       # restore all backups
"""

import argparse
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# ── colours ───────────────────────────────────────────────────────────────────
RST, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
RED, GRN, YEL, BLU, CYN = "\033[91m", "\033[92m", "\033[93m", "\033[94m", "\033[96m"

def col(c, t): return t if not sys.stdout.isatty() else f"{c}{t}{RST}"
def ok(m):   print(col(GRN, f"    \u2713 {m}"))
def warn(m): print(col(YEL, f"    \u26a0 {m}"))
def info(m): print(col(DIM, f"    \u00b7 {m}"))
def step(m): print(col(BLU, f"\n  \u25b6 {m}"))
def die(m):
    print(col(RED, f"\n  FATAL: {m}\n"))
    sys.exit(1)

TS = datetime.now().strftime("%Y%m%d-%H%M%S")
BAK_SUFFIX = f".bak.sim-{TS}"

# ── helpers ─────────────────────────────────────────────────────────────────────

def backup(p: Path, dry: bool):
    b = p.with_name(p.name + BAK_SUFFIX)
    if not dry:
        shutil.copy2(p, b)
    info(f"backup: {b.name}")
    return b

def read(p: Path) -> str:
    return p.read_text()

def write(p: Path, content: str, dry: bool):
    if not dry:
        p.write_text(content)

def run(cmd, cwd, dry: bool):
    info(f"$ {cmd}")
    if dry:
        return True
    r = subprocess.run(cmd, shell=True, cwd=cwd)
    return r.returncode == 0

# ── patch: api.ts ──────────────────────────────────────────────────────────────

def patch_api(target: Path, dry: bool):
    api = target / "frontend/src/lib/api.ts"
    if not api.exists():
        die(f"not found: {api}")
    src = read(api)

    if "simulatePacket" in src:
        warn("api.ts already has simulatePacket — skipping")
        return

    # Auto-detect the req() call style from the existing getRuleSet method.
    # Match: getRuleSet(...) { return this.req(`...`) }  (with or without await)
    m = re.search(
        r"getRuleSet\s*\([^)]*\)\s*\{\s*return\s+(this\.req<[^>]*>|this\.req)\s*\(",
        src,
    )
    if not m:
        die("could not find getRuleSet() in api.ts to mirror its req() style. "
            "Aborting before any edit. Paste lines 373-385 of api.ts and I'll adjust.")
    # Use the bare call (strip any <Generic>) so the new methods don't inherit
    # getRuleSet's return type; they return their own shapes.
    req_call = "this.req"
    info(f"detected request call style: {m.group(1)}(...) -> using {req_call}(...)")

    # Find the end of the deleteRule method to insert after it. We locate
    # 'deleteRule(' then walk to its closing brace by brace-counting.
    idx = src.find("deleteRule(")
    if idx == -1:
        die("could not find deleteRule() in api.ts. Aborting before any edit.")
    # find the opening brace of the method body
    brace_open = src.find("{", idx)
    depth, i = 0, brace_open
    while i < len(src):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    insert_at = i + 1  # just after deleteRule's closing brace

    methods = f"""

  // ── Rule simulation + shadow detection ──────────────────────────────────
  simulatePacket(id: string, family: string, name: string, packet: any) {{
    return {req_call}(`/api/v1/devices/${{id}}/firewall/${{family}}/rulesets/${{name}}/simulate`,
      {{ method: 'POST', body: JSON.stringify(packet) }});
  }}
  shadowAnalysis(id: string, family: string, name: string) {{
    return {req_call}(`/api/v1/devices/${{id}}/firewall/${{family}}/rulesets/${{name}}/shadow`);
  }}
  translatePreview(id: string, family: string, name: string, rule: any) {{
    return {req_call}(`/api/v1/devices/${{id}}/firewall/${{family}}/rulesets/${{name}}/translate-preview`,
      {{ method: 'POST', body: JSON.stringify(rule) }});
  }}"""

    new_src = src[:insert_at] + methods + src[insert_at:]
    backup(api, dry)
    write(api, new_src, dry)
    ok("api.ts patched (3 methods added after deleteRule)")

# ── patch: RuleSetEditor.tsx ─────────────────────────────────────────────────────

def patch_editor(target: Path, dry: bool):
    ed = target / "frontend/src/pages/RuleSetEditor.tsx"
    if not ed.exists():
        die(f"not found: {ed}")
    src = read(ed)

    if "RuleSimulationPanel" in src:
        warn("RuleSetEditor.tsx already references RuleSimulationPanel — skipping")
        return

    # 1) Add the import after the last existing import line.
    import_line = "import { RuleSimulationPanel } from '../components/simulation/RuleSimulationPanel'\n"
    last_import = 0
    for m in re.finditer(r"^import .*$", src, re.MULTILINE):
        last_import = m.end()
    if last_import == 0:
        die("no import statements found in RuleSetEditor.tsx. Aborting.")
    src = src[:last_import] + "\n" + import_line + src[last_import:]

    # 2) Mount the panel just before the final closing fragment </> of the
    #    component's return. We anchor on the LAST occurrence of '</>'.
    anchor = src.rfind("</>")
    if anchor == -1:
        die("could not find closing </> fragment in RuleSetEditor.tsx to mount the "
            "panel. Aborting before write — the editor may use a different wrapper.")
    mount = (
        "      {id && family && name && (\n"
        "        <RuleSimulationPanel id={id} family={family} name={name} />\n"
        "      )}\n"
    )
    src = src[:anchor] + mount + src[anchor:]

    backup(ed, dry)
    write(ed, src, dry)
    ok("RuleSetEditor.tsx patched (import + panel mount)")

# ── copy component files ─────────────────────────────────────────────────────────

def copy_components(srcdir: Path, target: Path, dry: bool):
    dest = target / "frontend/src/components/simulation"
    if not dry:
        dest.mkdir(parents=True, exist_ok=True)
    for fn in ("RuleSimulationPanel.tsx", "RuleSimulationPanel.css"):
        s = srcdir / fn
        if not s.exists():
            die(f"source file missing: {s}. Place the downloaded files in --src.")
        if not dry:
            shutil.copy2(s, dest / fn)
        ok(f"copied {fn} -> components/simulation/")

# ── rollback ─────────────────────────────────────────────────────────────────────

def rollback(target: Path):
    step("Rolling back all .bak.sim-* backups (most recent set)")
    candidates = sorted(target.rglob("*.bak.sim-*"))
    if not candidates:
        die("no .bak.sim-* backups found")
    # restore each backup over its original
    restored = 0
    for b in candidates:
        original = b.with_name(b.name.split(".bak.sim-")[0])
        shutil.copy2(b, original)
        ok(f"restored {original.relative_to(target)}")
        restored += 1
    print(col(GRN, f"\n  Restored {restored} file(s). Run 'make rebuild' to apply.\n"))

# ── main ─────────────────────────────────────────────────────────────────────────

def main():
    print(col(CYN, "\n  vyos-cp \u00b7 Simulation Frontend Deploy\n"))
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/home/ubuntu",
                    help="dir containing RuleSimulationPanel.tsx + .css (default /home/ubuntu)")
    ap.add_argument("--target", default="/opt/vyos-cp", help="repo root")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--rollback", action="store_true")
    args = ap.parse_args()

    target = Path(args.target).resolve()
    srcdir = Path(args.src).resolve()

    if not target.exists():
        die(f"target repo not found: {target}")

    if args.rollback:
        rollback(target)
        return

    if args.dry_run:
        print(col(YEL, "  DRY RUN — no files will be written.\n"))

    step("1. Copying component + CSS")
    copy_components(srcdir, target, args.dry_run)

    step("2. Patching api.ts (add 3 methods)")
    patch_api(target, args.dry_run)

    step("3. Patching RuleSetEditor.tsx (import + mount)")
    patch_editor(target, args.dry_run)

    if args.no_build or args.dry_run:
        step("4. Build")
        info("skipped (--no-build or --dry-run)")
    else:
        step("4. Building frontend")
        if not run("make frontend", str(target), False):
            die("make frontend failed. Your source files are intact; "
                "run with --rollback to restore patched files, then inspect the error.")
        ok("frontend built")

        step("5. Rebuilding stack")
        if not run("make rebuild", str(target), False):
            die("make rebuild failed. Check 'docker compose config' and 'make logs'.")
        ok("stack rebuilt")

    print(col(GRN, col(BOLD, "\n  \u2713 Done.")))
    print(f"\n  {col(DIM, 'Open')} http://<host>:8080 {col(DIM, '-> Rule-sets -> a rule-set editor.')}")
    print(f"  {col(DIM, 'Three panels appear below the rules table:')}")
    print("    Rule Simulation \u00b7 Shadow & Risk Analysis \u00b7 Rule Trace")
    print(f"\n  {col(DIM, 'Backups tagged')} {BAK_SUFFIX}")
    print(f"  {col(DIM, 'Undo with:')} python3 {Path(sys.argv[0]).name} --rollback --target {target}\n")


if __name__ == "__main__":
    main()
