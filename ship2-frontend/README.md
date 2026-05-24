# Ship 2 — Frontend bundle

The backend for Ship 2 is already deployed and proven (you saw the diff
endpoint return three real changes). This bundle is just the missing UI.

## Two files

- `LiveConfigTab.tsx` — replaces your existing version. Adds three sub-tabs
  (Current · History · Diff), a snapshot picker, and a diff renderer.
- `api.ts.patch` — reference snippets to add to `frontend/src/lib/api.ts`.
  (You don't need to apply this by hand; the installer does it for you.)

## Quickest path: run the installer

```bash
# 1. Copy this bundle to /opt/vyos-cp/ship2-frontend/
#    (assuming you've unzipped or scp'd the files there)

cd /opt/vyos-cp

# 2. Run the installer from the repo root
./ship2-frontend/install-ship2-frontend.sh

# 3. Rebuild
make rebuild

# 4. Bring the stack back up
docker compose up -d
```

The installer:

1. Backs up your existing `LiveConfigTab.tsx` and `api.ts` to
   `.ship2-backup/<timestamp>/`
2. Replaces `LiveConfigTab.tsx` with the Ship 2 version
3. Adds the diff types and two new methods to `api.ts` (idempotent)
4. Prints what to do next

Hard-refresh your browser after the stack is back up. The Live Config tab
should now have a sub-tab row at the top right.

## Manual install (if you don't want to use the script)

### 1. Replace LiveConfigTab.tsx

```bash
cp /opt/vyos-cp/ship2-frontend/LiveConfigTab.tsx \
   /opt/vyos-cp/frontend/src/pages/LiveConfigTab.tsx
```

### 2. Edit api.ts

Open `/opt/vyos-cp/frontend/src/lib/api.ts`. Two additions, both shown in
`api.ts.patch`:

- Add the `DiffOp` / `DiffChange` / `SnapshotDiff` type block **just
  before** the line `export const api = new API();`
- Add the `getSnapshotByID` and `computeDiff` methods **inside the API
  class**, right after the existing `captureSnapshotNow(...)` method
  (which Ship 1 added)

### 3. Rebuild

```bash
cd /opt/vyos-cp
make rebuild
docker compose up -d
```

## What you should see

After a hard refresh, the Live Config tab has three sub-tabs:

```
Live Config                              [ Current ] [ History ] [ Diff ]
```

- **Current** — same view you had under Ship 1 (capture metadata + JSON
  tree). The "Refresh now" button still works.
- **History** — a table of past snapshots. Click any two checkboxes to
  pick them. The Diff tab activates when 2 are selected.
- **Diff** — unified diff between the two selected snapshots. Adds in
  green with `+`, removes in red with `−`, modifications in amber with
  `~`. Dotted paths, before/after values. A free-text filter at the top
  right narrows by path substring.

## Rollback

If anything looks wrong, restore from backups:

```bash
LATEST=$(ls -t /opt/vyos-cp/.ship2-backup/ | head -1)
cp /opt/vyos-cp/.ship2-backup/$LATEST/frontend/src/pages/LiveConfigTab.tsx \
   /opt/vyos-cp/frontend/src/pages/LiveConfigTab.tsx
cp /opt/vyos-cp/.ship2-backup/$LATEST/frontend/src/lib/api.ts \
   /opt/vyos-cp/frontend/src/lib/api.ts
cd /opt/vyos-cp && make rebuild
```

That puts you back to the Ship 1 state. The diff backend endpoints stay,
they just become orphaned (nothing calls them) until you re-install Ship 2.

## Notes

- Tailwind classes used in this file match the patterns already in your
  codebase (px/py-N, rounded, gray-50/100/200, etc.). If a class doesn't
  render correctly, your Tailwind config may be excluding the new file —
  unlikely since it's in the same `pages/` directory as everything else.
- The diff path filter is client-side. The server returns the full diff;
  the UI filters via `path.toLowerCase().includes(...)`.
- Sub-tab buttons are styled as rounded pills (blue when active, gray on
  hover). If you'd rather they match the device-level tabs (underline
  style, transparent background), swap the className in `TabButton` for
  `border-b-2 border-transparent hover:border-gray-300`-style classes.
