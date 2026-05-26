#!/usr/bin/env python3
"""Wire daily/monthly rollup into the existing usage rollup loop.

The loop currently calls p.runUsageRollup(ctx, d.ID) per device. We add a call
to p.runDailyMonthlyRollup(ctx, d.ID) right after it, so each 5-minute tick
recomputes hourly buckets and then derives day/month buckets from them.
Idempotent and additive.
"""
import sys, shutil, re

F = "backend/internal/poller/usage_wiring.go"
s = open(F).read()

if "runDailyMonthlyRollup" in s:
    print("daily/monthly rollup already wired — nothing to do.")
    sys.exit(0)

# Anchor on the per-device hourly call inside usageRollupLoop.
anchor = "\t\t\t\tp.runUsageRollup(ctx, d.ID)"
if s.count(anchor) != 1:
    # try a looser indentation-agnostic match
    m = re.search(r"^(\s*)p\.runUsageRollup\(ctx, d\.ID\)\s*$", s, re.M)
    if not m:
        print("ABORTED: could not find the 'p.runUsageRollup(ctx, d.ID)' call in")
        print(f"  {F}. Add this line right after it, by hand:")
        print("      p.runDailyMonthlyRollup(ctx, d.ID)")
        sys.exit(1)
    indent = m.group(1)
    new = m.group(0) + "\n" + indent + "p.runDailyMonthlyRollup(ctx, d.ID)"
    shutil.copy(F, F + ".bak.daily")
    s = s[:m.start()] + new + s[m.end():]
    open(F, "w").write(s)
    print("OK — daily/monthly rollup wired into usageRollupLoop (loose match).")
    sys.exit(0)

new = anchor + "\n\t\t\t\tp.runDailyMonthlyRollup(ctx, d.ID)"
shutil.copy(F, F + ".bak.daily")
open(F, "w").write(s.replace(anchor, new, 1))
print("OK — daily/monthly rollup wired into usageRollupLoop.")
