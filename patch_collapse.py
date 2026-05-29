#!/usr/bin/env python3
import sys, os, shutil, re

F = "frontend/src/pages/QoS.tsx"
s = open(F).read()
orig = s

if "qos-section" in s or "openBands" in s:
    print("Collapsible already present — nothing to do.")
    sys.exit(0)

problems = []

# --- 1. Add state. Anchor on the binding useState line.
state_anchor = "  const [binding, setBinding] = useState<{ policy: string } | null>(null)"
state_add = state_anchor + """
  const [openBands, setOpenBands] = useState({ state: true, detail: true, config: false })
  const toggleBand = (k: 'state' | 'detail' | 'config') =>
    setOpenBands(o => ({ ...o, [k]: !o[k] }))"""
if s.count(state_anchor) == 1:
    s = s.replace(state_anchor, state_add, 1)
else:
    problems.append(f"state anchor matched {s.count(state_anchor)}x (expected 1)")

# --- helper to make a band header clickable + open a wrapper
def band_header(label, sub, key):
    return (f'      <div className="qos-band qos-band-toggle" onClick={{() => toggleBand(\'{key}\')}}>'
            f'<span className="qos-chevron">{{openBands.{key} ? \'\\u25be\' : \'\\u25b8\'}}</span>'
            f'{label} <span>{sub}</span></div>\n'
            f'      <div className={{\'qos-section\' + (openBands.{key} ? \'\' : \' collapsed\')}}>')

# --- 2. STATE band: header + QoSTraffic, wrap just QoSTraffic
state_old = '''      <div className="qos-band">State <span>live &amp; configured</span></div>
      <QoSTraffic deviceId={id!} policies={policies} />'''
state_new = (band_header('State', 'live &amp; configured', 'state') + '\n'
             '      <QoSTraffic deviceId={id!} policies={policies} />\n'
             '      </div>')
if s.count(state_old) == 1:
    s = s.replace(state_old, state_new, 1)
else:
    problems.append(f"STATE band anchor matched {s.count(state_old)}x")

# --- 3. DETAIL band
detail_old = '''      <div className="qos-band">Detail <span>usage &amp; shaping path</span></div>
      <QoSOverview policies={policies} bindings={bindingsQ.data || []} />'''
detail_new = (band_header('Detail', 'usage &amp; shaping path', 'detail') + '\n'
              '      <QoSOverview policies={policies} bindings={bindingsQ.data || []} />\n'
              '      </div>')
if s.count(detail_old) == 1:
    s = s.replace(detail_old, detail_new, 1)
else:
    problems.append(f"DETAIL band anchor matched {s.count(detail_old)}x")

# --- 4. CONFIGURATION band: header opens wrapper; wrapper closes after FlowsView.
config_hdr_old = '      <div className="qos-band">Configuration <span>edit surfaces</span></div>'
config_hdr_new = band_header('Configuration', 'edit surfaces', 'config')
if s.count(config_hdr_old) == 1:
    s = s.replace(config_hdr_old, config_hdr_new, 1)
else:
    problems.append(f"CONFIG header anchor matched {s.count(config_hdr_old)}x")

# close the config wrapper right after <FlowsView .../> and before the modals.
flows_old = "      <FlowsView deviceId={id!} />\n"
flows_new = "      <FlowsView deviceId={id!} />\n      </div>\n"
if s.count(flows_old) == 1:
    s = s.replace(flows_old, flows_new, 1)
else:
    problems.append(f"FlowsView close anchor matched {s.count(flows_old)}x")

if problems:
    print("ABORTED — anchors not uniquely matched:")
    for p in problems: print("  -", p)
    sys.exit(2)

# balance check
b = s.count("{") - s.count("}")
par = s.count("(") - s.count(")")
if b != 0 or par != 0:
    print(f"ABORTED — balance off after edit (braces {b}, parens {par}); not writing.")
    sys.exit(3)

shutil.copy(F, F + ".bak.collapse")
open(F, "w").write(s)
print("OK — QoS.tsx: 3 bands made collapsible (config collapsed by default).")
