#!/usr/bin/env python3
"""
Adds Local ID / Remote ID fields to the IPsec peer wizard and edit form.
Run from /opt/vyos-cp:  python3 /home/ubuntu/app-patches/patch_ipsec_ids.py

Safe: every edit asserts exactly one match. If any anchor fails, NOTHING is
written and the script reports which edit didn't match, so the file is never
left half-patched. A .bak is made first.
"""
import re, sys, shutil

F = "frontend/src/pages/IPsec.tsx"

try:
    src = open(F).read()
except FileNotFoundError:
    sys.exit(f"ERROR: {F} not found. Run from the repo root (/opt/vyos-cp).")

edits = []  # (label, pattern, replacement)

# --- WIZARD ---------------------------------------------------------------

# 1. WizardState type: add local_id/remote_id after `psk: string`
edits.append((
    "wizardstate-type",
    re.compile(r'(\n  psk: string\n)'),
    r'\1  local_id: string\n  remote_id: string\n',
))

# 2. defaults object: add after `psk: '',`
edits.append((
    "wizardstate-defaults",
    re.compile(r"(\n  psk: '',\n)"),
    r"\1  local_id: '',\n  remote_id: '',\n",
))

# 3. wizard authentication object: widen to carry the ids
edits.append((
    "wizard-auth-object",
    re.compile(r"authentication: \{ mode: 'pre-shared-secret', pre_shared_secret: s\.psk \},"),
    ("authentication: {\n"
     "        mode: 'pre-shared-secret',\n"
     "        pre_shared_secret: s.psk,\n"
     "        local_id: s.local_id || undefined,\n"
     "        remote_id: s.remote_id || undefined,\n"
     "      },"),
))

# 4. wizard Authentication SECTION: inject the two id inputs right after the
#    PSK <section> opener line. Anchor on the unique section-head text.
edits.append((
    "wizard-id-inputs",
    re.compile(r'(<div className="wiz-section-head">Authentication</div>\n)'),
    (r'\1'
     '              <div className="row2">\n'
     '                <div className="field">\n'
     '                  <label>Local ID</label>\n'
     '                  <input type="text" value={s.local_id} onChange={e => set({ local_id: e.target.value })}\n'
     '                    placeholder={s.local_address || \'defaults to local address\'} />\n'
     '                </div>\n'
     '                <div className="field">\n'
     '                  <label>Remote ID</label>\n'
     '                  <input type="text" value={s.remote_id} onChange={e => set({ remote_id: e.target.value })}\n'
     '                    placeholder={s.remote_address || \'defaults to remote address\'} />\n'
     '                </div>\n'
     '              </div>\n'),
))

# --- EDIT FORM ------------------------------------------------------------

# 5. edit-form useState: add localId/remoteId next to localAddress state.
edits.append((
    "editform-usestate",
    re.compile(r"(\n  const \[localAddress, setLocalAddress\] = useState\(peer\.local_address \|\| ''\)\n)"),
    (r"\1"
     "  const [localId, setLocalId] = useState(peer.authentication?.local_id || '')\n"
     "  const [remoteId, setRemoteId] = useState(peer.authentication?.remote_id || '')\n"),
))

# 6. edit-form dirty check: add the two comparisons after localAddress line.
edits.append((
    "editform-dirty",
    re.compile(r"(\n    localAddress !== \(peer\.local_address \|\| ''\) \|\|\n)"),
    (r"\1"
     "    localId !== (peer.authentication?.local_id || '') ||\n"
     "    remoteId !== (peer.authentication?.remote_id || '') ||\n"),
))

# 7. edit-form authentication object: thread the ids through.
edits.append((
    "editform-auth-object",
    re.compile(
        r"authentication: \{\n"
        r"\s*\.\.\.peer\.authentication,\n"
        r"\s*// Empty psk → omit → backend preserves the existing secret\.\n"
        r"\s*// Non-empty → set the new value \(rotate the PSK\)\.\n"
        r"\s*pre_shared_secret: psk \|\| undefined,\n"
        r"\s*\},"
    ),
    ("authentication: {\n"
     "          ...peer.authentication,\n"
     "          pre_shared_secret: psk || undefined,\n"
     "          local_id: localId || undefined,\n"
     "          remote_id: remoteId || undefined,\n"
     "        },"),
))

# Dry-run: verify every edit matches exactly once BEFORE writing anything.
problems = []
for label, pat, _ in edits:
    n = len(pat.findall(src))
    if n != 1:
        problems.append(f"  [{label}] matched {n} times (expected 1)")

if problems:
    print("ABORTED — no changes written. Anchor mismatches:")
    print("\n".join(problems))
    print("\nThe edit-form JSX input block (#8) is intentionally NOT auto-applied;")
    print("add it by hand — see the README. The mismatches above are likely due to")
    print("local edits to IPsec.tsx; paste the affected region and I'll re-anchor.")
    sys.exit(1)

# All good — back up and apply.
shutil.copy(F, F + ".bak.ipsec-ids")
out = src
for label, pat, repl in edits:
    out = pat.sub(repl, out, count=1)
open(F, "w").write(out)
print("OK — applied 7 edits. Backup at", F + ".bak.ipsec-ids")
print()
print("MANUAL STEP (#8): add the Local ID / Remote ID inputs to the EDIT form JSX.")
print("Place this right after the edit form's local/remote address row2 block:")
print("""
        <div className="row2">
          <div className="field">
            <label>Local ID</label>
            <input type="text" value={localId} onChange={e => setLocalId(e.target.value)}
              placeholder={localAddress || 'defaults to local address'} />
          </div>
          <div className="field">
            <label>Remote ID</label>
            <input type="text" value={remoteId} onChange={e => setRemoteId(e.target.value)}
              placeholder={remoteAddress || 'defaults to remote address'} />
          </div>
        </div>
""")
