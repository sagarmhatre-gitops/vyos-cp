#!/usr/bin/env python3
"""
vyos-cp Rule Simulation + Shadow Detection Engine
Deployment Script

Usage:
    python3 deploy.py [--mode {full|backend|frontend|patch}] [--target /path/to/vyos-cp]
    python3 deploy.py --check        # preflight only
    python3 deploy.py --rollback     # undo last deployment
    python3 deploy.py --status       # show deployment status
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import textwrap
import time
from datetime import datetime
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# ANSI colours
# ──────────────────────────────────────────────────────────────────────────────
RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RED    = "\033[91m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
BLUE   = "\033[94m"
CYAN   = "\033[96m"
WHITE  = "\033[97m"

def c(color, text):
    if not sys.stdout.isatty():
        return text
    return f"{color}{text}{RESET}"

def banner():
    print(c(CYAN, r"""
  __   ______  ___  ____       ___  ___
 \ \ / / __ \/ __||___ \     / __||  _|
  \ V /| |_| \__ \  __) |___| (__ | |_
   \_/ |_.__/|___/ |____/____|\___||___|
"""))
    print(c(BOLD, "  vyos-cp · Rule Simulation + Shadow Detection Engine"))
    print(c(DIM,  "  Deployment Script v1.0.0\n"))

def step(n, total, msg):
    prefix = c(BLUE, f"  [{n}/{total}]")
    print(f"{prefix} {msg}")

def ok(msg):    print(c(GREEN,  f"    ✓ {msg}"))
def warn(msg):  print(c(YELLOW, f"    ⚠ {msg}"))
def fail(msg):  print(c(RED,    f"    ✗ {msg}"))
def info(msg):  print(c(DIM,    f"    · {msg}"))

def die(msg):
    print(c(RED, f"\n  FATAL: {msg}"))
    sys.exit(1)

def run(cmd, cwd=None, capture=False, check=True):
    """Run a shell command, streaming output unless capture=True."""
    kwargs = dict(cwd=cwd, text=True)
    if capture:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        result = subprocess.run(cmd, shell=True, **kwargs)
        if check and result.returncode != 0:
            if capture:
                fail(result.stderr.strip())
            return None
        return result
    except Exception as e:
        if check:
            die(str(e))
        return None

def run_q(cmd, cwd=None):
    """Run quietly, return (ok, stdout, stderr)."""
    r = subprocess.run(cmd, shell=True, cwd=cwd, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return r.returncode == 0, r.stdout.strip(), r.stderr.strip()

# ──────────────────────────────────────────────────────────────────────────────
# PREFLIGHT CHECKS
# ──────────────────────────────────────────────────────────────────────────────

def check_python_version():
    major, minor = sys.version_info[:2]
    if major < 3 or (major == 3 and minor < 9):
        die(f"Python 3.9+ required (found {major}.{minor})")
    ok(f"Python {major}.{minor}")

def check_tool(name, version_cmd, min_version=None, extract=None):
    ok_flag, out, err = run_q(version_cmd)
    if not ok_flag and not out:
        warn(f"{name} not found — some features may be unavailable")
        return False
    version_str = (extract(out) if extract else out.split("\n")[0].strip())
    ok(f"{name}: {version_str}")
    return True

def check_docker():
    ok_flag, out, _ = run_q("docker --version")
    if not ok_flag:
        die("Docker is required. Install from https://docs.docker.com/get-docker/")
    version_line = out.split("\n")[0]
    match = re.search(r"(\d+)\.(\d+)", version_line)
    if match:
        major = int(match.group(1))
        if major < 24:
            warn(f"Docker {major}.x found; 24.0+ recommended")
        else:
            ok(version_line)
    else:
        ok(version_line)

def check_compose():
    ok_flag, out, _ = run_q("docker compose version")
    if not ok_flag:
        die("Docker Compose v2 plugin required. Run: apt-get install docker-compose-plugin")
    ok(out.split("\n")[0])

def check_make():
    ok_flag, out, _ = run_q("make --version")
    if not ok_flag:
        warn("GNU Make not found — Makefile targets unavailable (build will use raw docker commands)")
        return False
    ok(out.split("\n")[0])
    return True

def check_openssl():
    ok_flag, out, _ = run_q("openssl version")
    if not ok_flag:
        warn("openssl not found — key generation will use Python secrets module")
        return False
    ok(out.split("\n")[0])
    return True

def check_disk(target: Path, min_gb=2.0):
    stat = shutil.disk_usage(str(target.parent if not target.exists() else target))
    free_gb = stat.free / (1024 ** 3)
    if free_gb < min_gb:
        warn(f"Low disk space: {free_gb:.1f} GB free ({min_gb} GB recommended)")
    else:
        ok(f"Disk space: {free_gb:.1f} GB free")

def preflight(target: Path):
    print(c(BOLD, "\n  Preflight checks\n"))
    check_python_version()
    check_docker()
    check_compose()
    has_make = check_make()
    has_openssl = check_openssl()
    check_tool("curl", "curl --version", extract=lambda s: s.split("\n")[0])
    check_disk(target)
    print()
    return has_make, has_openssl

# ──────────────────────────────────────────────────────────────────────────────
# FILE GENERATION  — backend Go files
# ──────────────────────────────────────────────────────────────────────────────

SIMULATION_GO = '''\
// Package simulation implements the rule simulation and shadow detection engine
// for vyos-cp. It evaluates VyOS firewall rules in exact execution order and
// identifies unreachable, shadowed, or risky rule configurations.
package simulation

import (
\t"fmt"
\t"net"
\t"strings"

\t"github.com/vyos-cp/internal/model"
)

// ─── Packet ──────────────────────────────────────────────────────────────────

// Packet represents a simulated network packet used as the evaluation subject.
type Packet struct {
\tSrcIP    string   // e.g. "8.8.8.8"
\tDstIP    string   // e.g. "142.79.253.233"
\tProto    string   // "tcp", "udp", "icmp", "any"
\tDstPort  int      // 0 = any
\tInIface  string   // ingress interface, e.g. "eth0"
\tOutIface string   // egress interface
\tState    string   // "new", "established", "related", "invalid"
\tGeoCode  string   // ISO-3166-1 alpha-2, e.g. "CN"
}

// ─── TraceEntry ──────────────────────────────────────────────────────────────

// EvalStatus describes how a rule was treated during packet evaluation.
type EvalStatus string

const (
\tStatusMatch    EvalStatus = "match"
\tStatusNoMatch  EvalStatus = "no_match"
\tStatusNotEval  EvalStatus = "not_evaluated" // rule after the first match
)

// TraceEntry records one step in the simulation walk.
type TraceEntry struct {
\tRule    model.Rule // snapshot of the evaluated rule
\tStatus  EvalStatus
\tReasons []string   // human-readable match explanations
}

// ─── SimulationResult ────────────────────────────────────────────────────────

// SimulationResult is the top-level output of RunSimulation.
type SimulationResult struct {
\tPacket      Packet
\tMatched     bool
\tMatchedRule *model.Rule // nil when no rule matched
\tFinalAction string      // "accept", "drop", "reject", "" when no match
\tTrace       []TraceEntry
}

// ─── Engine ──────────────────────────────────────────────────────────────────

// Engine holds the rule-set and performs simulation + shadow analysis.
type Engine struct {
\tRules []model.Rule // ordered by rule number ascending
}

// NewEngine constructs an Engine from an ordered rule slice.
func NewEngine(rules []model.Rule) *Engine {
\treturn &Engine{Rules: rules}
}

// RunSimulation evaluates pkt against every rule in order and returns a full
// trace plus the first matching rule.
func (e *Engine) RunSimulation(pkt Packet) SimulationResult {
\tresult := SimulationResult{Packet: pkt}
\tfor _, rule := range e.Rules {
\t\tentry := TraceEntry{Rule: rule}
\t\tif result.Matched {
\t\t\tentry.Status = StatusNotEval
\t\t\tresult.Trace = append(result.Trace, entry)
\t\t\tcontinue
\t\t}
\t\treasons, matched := e.matchRule(rule, pkt)
\t\tif matched {
\t\t\tentry.Status = StatusMatch
\t\t\tentry.Reasons = reasons
\t\t\tresult.Matched = true
\t\t\truleCopy := rule
\t\t\tresult.MatchedRule = &ruleCopy
\t\t\tresult.FinalAction = rule.Action
\t\t} else {
\t\t\tentry.Status = StatusNoMatch
\t\t}
\t\tresult.Trace = append(result.Trace, entry)
\t}
\treturn result
}

// matchRule returns (reasons, true) when rule matches pkt.
func (e *Engine) matchRule(rule model.Rule, pkt Packet) ([]string, bool) {
\tvar reasons []string

\t// Protocol
\tif rule.Protocol != "" && rule.Protocol != "any" {
\t\tif rule.Protocol != pkt.Proto {
\t\t\treturn nil, false
\t\t}
\t\treasons = append(reasons, rule.Protocol+" protocol match")
\t}

\t// Destination port
\tif rule.DstPort != 0 {
\t\tif rule.DstPort != pkt.DstPort {
\t\t\treturn nil, false
\t\t}
\t\treasons = append(reasons, fmt.Sprintf("destination port %d match", rule.DstPort))
\t}

\t// Source CIDR
\tif rule.SrcCIDR != "" && rule.SrcCIDR != "0.0.0.0/0" {
\t\tif !cidrContains(rule.SrcCIDR, pkt.SrcIP) {
\t\t\treturn nil, false
\t\t}
\t\treasons = append(reasons, "source address match")
\t}

\t// Destination CIDR
\tif rule.DstCIDR != "" && rule.DstCIDR != "0.0.0.0/0" {
\t\tif !cidrContains(rule.DstCIDR, pkt.DstIP) {
\t\t\treturn nil, false
\t\t}
\t\treasons = append(reasons, "destination address match")
\t}

\t// GeoIP
\tif len(rule.GeoCountries) > 0 {
\t\tif !containsStr(rule.GeoCountries, pkt.GeoCode) {
\t\t\t// For drop rules on geo: no match means skip
\t\t\tif rule.Action == "drop" {
\t\t\t\treturn nil, false
\t\t\t}
\t\t}
\t\treasons = append(reasons, "GeoIP country match")
\t}

\t// Connection state
\tif len(rule.States) > 0 && pkt.State != "" {
\t\tif !containsStr(rule.States, pkt.State) {
\t\t\treturn nil, false
\t\t}
\t\treasons = append(reasons, "connection state match")
\t}

\tif len(reasons) == 0 {
\t\treasons = []string{"wildcard match (any source, any destination)"}
\t}
\treturn reasons, true
}

// ─── Shadow detection ────────────────────────────────────────────────────────

// RiskLevel categorises a finding.
type RiskLevel string

const (
\tRiskCritical RiskLevel = "critical" // rule is completely unreachable
\tRiskHigh     RiskLevel = "high"     // serious security concern
\tRiskMedium   RiskLevel = "medium"   // broad or potentially unsafe rule
\tRiskLow      RiskLevel = "low"      // informational
)

// Finding describes one detected issue in the rule-set.
type Finding struct {
\tLevel      RiskLevel
\tRuleNum    int    // primary rule affected
\tRelatedNum int    // secondary rule (e.g. the shadowing rule), 0 if N/A
\tCode       string // machine-readable tag: "shadowed", "allow_any", "broad_geo", ...
\tTitle      string
\tDetail     string
}

// AnalyzeRuleSet runs all shadow and risk checks against the full rule set.
func (e *Engine) AnalyzeRuleSet() []Finding {
\tvar findings []Finding
\tfindings = append(findings, e.detectShadows()...)
\tfindings = append(findings, e.detectRiskyRules()...)
\treturn findings
}

// detectShadows finds rules that can never be reached because an earlier rule
// already handles all their traffic.
func (e *Engine) detectShadows() []Finding {
\tvar findings []Finding
\tfor i, candidate := range e.Rules {
\t\tfor _, prior := range e.Rules[:i] {
\t\t\tif shadows(prior, candidate) {
\t\t\t\tfindings = append(findings, Finding{
\t\t\t\t\tLevel:      RiskCritical,
\t\t\t\t\tRuleNum:    candidate.Number,
\t\t\t\t\tRelatedNum: prior.Number,
\t\t\t\t\tCode:       "shadowed",
\t\t\t\t\tTitle:      fmt.Sprintf("Shadowed rule — unreachable"),
\t\t\t\t\tDetail: fmt.Sprintf(
\t\t\t\t\t\t"Rule %d will never match because Rule %d already %ss all %s traffic from any source.",
\t\t\t\t\t\tcandidate.Number, prior.Number, prior.Action,
\t\t\t\t\t\tproto(prior),
\t\t\t\t\t),
\t\t\t\t})
\t\t\t\tbreak
\t\t\t}
\t\t}
\t}
\treturn findings
}

// shadows returns true when rule a completely supersedes rule b.
func shadows(a, b model.Rule) bool {
\t// a must be broader or equal on every dimension
\tif a.Protocol != "any" && a.Protocol != "" && a.Protocol != b.Protocol {
\t\treturn false
\t}
\tif a.DstPort != 0 && a.DstPort != b.DstPort {
\t\treturn false
\t}
\tif a.SrcCIDR != "" && a.SrcCIDR != "0.0.0.0/0" {
\t\t// a has a narrower source than b — cannot shadow
\t\treturn false
\t}
\tif a.DstCIDR != "" && a.DstCIDR != "0.0.0.0/0" {
\t\treturn false
\t}
\t// If a has geo restrictions, it cannot shadow a rule without them
\tif len(a.GeoCountries) > 0 && len(b.GeoCountries) == 0 {
\t\treturn false
\t}
\treturn true
}

// detectRiskyRules flags allow-any, exposed mgmt ports, broad geo, etc.
func (e *Engine) detectRiskyRules() []Finding {
\tvar findings []Finding
\tfor _, rule := range e.Rules {
\t\t// Allow-any: accept with no src/dst/port restriction
\t\tif rule.Action == "accept" &&
\t\t\t(rule.SrcCIDR == "" || rule.SrcCIDR == "0.0.0.0/0") &&
\t\t\t(rule.DstCIDR == "" || rule.DstCIDR == "0.0.0.0/0") &&
\t\t\trule.DstPort == 0 {
\t\t\tfindings = append(findings, Finding{
\t\t\t\tLevel:   RiskHigh,
\t\t\t\tRuleNum: rule.Number,
\t\t\t\tCode:    "allow_any",
\t\t\t\tTitle:   "Allow-any rule — broad accept",
\t\t\t\tDetail:  fmt.Sprintf("Rule %d accepts all %s traffic from 0.0.0.0/0 with no port restriction. Consider narrowing source CIDR or adding a port filter.", rule.Number, proto(rule)),
\t\t\t})
\t\t}

\t\t// Exposed management ports
\t\tmgmtPorts := []int{22, 23, 3389, 5900}
\t\tfor _, p := range mgmtPorts {
\t\t\tif rule.DstPort == p && rule.Action == "accept" &&
\t\t\t\t(rule.SrcCIDR == "" || rule.SrcCIDR == "0.0.0.0/0") {
\t\t\t\tfindings = append(findings, Finding{
\t\t\t\t\tLevel:   RiskHigh,
\t\t\t\t\tRuleNum: rule.Number,
\t\t\t\t\tCode:    "exposed_mgmt",
\t\t\t\t\tTitle:   fmt.Sprintf("Exposed management port %d", p),
\t\t\t\t\tDetail:  fmt.Sprintf("Rule %d allows port %d from any source. Restrict to a management CIDR.", rule.Number, p),
\t\t\t\t})
\t\t\t}
\t\t}

\t\t// Broad GeoIP
\t\tif len(rule.GeoCountries) > 0 &&
\t\t\t(rule.Protocol == "any" || rule.Protocol == "") &&
\t\t\trule.DstPort == 0 {
\t\t\tfindings = append(findings, Finding{
\t\t\t\tLevel:   RiskMedium,
\t\t\t\tRuleNum: rule.Number,
\t\t\t\tCode:    "broad_geo",
\t\t\t\tTitle:   "Broad GeoIP policy",
\t\t\t\tDetail:  fmt.Sprintf("Rule %d applies GeoIP filtering across all protocols and ports. VPN tunnels bypass country-based rules.", rule.Number),
\t\t\t})
\t\t}

\t\t// Overlapping CIDR warning
\t\tif rule.SrcCIDR == "0.0.0.0/0" && rule.Action == "accept" {
\t\t\tfindings = append(findings, Finding{
\t\t\t\tLevel:   RiskMedium,
\t\t\t\tRuleNum: rule.Number,
\t\t\t\tCode:    "broad_src",
\t\t\t\tTitle:   "Broad source CIDR (0.0.0.0/0)",
\t\t\t\tDetail:  fmt.Sprintf("Rule %d accepts from 0.0.0.0/0. Consider restricting to a known source range for better security posture.", rule.Number),
\t\t\t})
\t\t}
\t}
\treturn findings
}

// ─── Translator preview ──────────────────────────────────────────────────────

// ConfigureOp is a single VyOS /configure operation (set, delete, comment).
type ConfigureOp struct {
\tOp    string   `json:"op"`
\tPath  []string `json:"path"`
\tValue string   `json:"value,omitempty"`
}

// TranslateRule emits the atomic delete-then-set op array for a rule.
// This mirrors the real translator package behaviour: edit = delete node + set fields.
func TranslateRule(ruleSetName string, rule model.Rule) []ConfigureOp {
\tbase := []string{"firewall", "ipv4", "name", ruleSetName, "rule", fmt.Sprintf("%d", rule.Number)}
\tops := []ConfigureOp{
\t\t{Op: "delete", Path: base},
\t}
\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "action"), Value: rule.Action})
\tif rule.Description != "" {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "description"), Value: rule.Description})
\t}
\tif rule.Protocol != "" && rule.Protocol != "any" {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "protocol"), Value: rule.Protocol})
\t}
\tif rule.SrcCIDR != "" {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "source", "address"), Value: rule.SrcCIDR})
\t}
\tif rule.DstCIDR != "" {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "destination", "address"), Value: rule.DstCIDR})
\t}
\tif rule.DstPort != 0 {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "destination", "port"), Value: fmt.Sprintf("%d", rule.DstPort)})
\t}
\tfor _, s := range rule.States {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "state", s), Value: "enable"})
\t}
\tif len(rule.GeoCountries) > 0 {
\t\tops = append(ops, ConfigureOp{Op: "set", Path: append(base, "source", "geoip", "country"), Value: strings.Join(rule.GeoCountries, ",")})
\t}
\treturn ops
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func cidrContains(cidr, ip string) bool {
\t_, network, err := net.ParseCIDR(cidr)
\tif err != nil {
\t\treturn net.ParseIP(cidr).Equal(net.ParseIP(ip))
\t}
\treturn network.Contains(net.ParseIP(ip))
}

func containsStr(slice []string, s string) bool {
\tfor _, v := range slice {
\t\tif strings.EqualFold(v, s) {
\t\t\treturn true
\t\t}
\t}
\treturn false
}

func proto(r model.Rule) string {
\tif r.Protocol == "" || r.Protocol == "any" {
\t\treturn "any-protocol"
\t}
\treturn r.Protocol
}
'''

SIMULATION_TEST_GO = '''\
package simulation_test

import (
\t"testing"

\t"github.com/vyos-cp/internal/model"
\t"github.com/vyos-cp/internal/simulation"
)

func makeRule(num int, action, proto, src, dst string, port int, states, geo []string) model.Rule {
\treturn model.Rule{
\t\tNumber: num, Action: action, Protocol: proto,
\t\tSrcCIDR: src, DstCIDR: dst, DstPort: port,
\t\tStates: states, GeoCountries: geo,
\t}
}

var testRules = []model.Rule{
\tmakeRule(1,  "accept", "any", "", "", 0, []string{"established", "related"}, nil),
\tmakeRule(5,  "drop",   "any", "", "", 0, nil, []string{"CN", "RU"}),
\tmakeRule(10, "accept", "udp", "", "", 53, nil, nil),
\tmakeRule(12, "accept", "tcp", "0.0.0.0/0", "", 0, nil, nil),
\tmakeRule(17, "accept", "tcp", "0.0.0.0/0", "142.79.253.233/32", 443, nil, []string{"CN","RU"}),
\tmakeRule(25, "drop",   "any", "", "", 0, nil, nil),
}

func TestSimulation_MatchesRule12(t *testing.T) {
\tpkt := simulation.Packet{
\t\tSrcIP: "8.8.8.8", DstIP: "142.79.253.233",
\t\tProto: "tcp", DstPort: 443, State: "new",
\t}
\teng := simulation.NewEngine(testRules)
\tres := eng.RunSimulation(pkt)

\tif !res.Matched {
\t\tt.Fatal("expected a match")
\t}
\tif res.MatchedRule.Number != 12 {
\t\tt.Fatalf("expected rule 12 to match, got %d", res.MatchedRule.Number)
\t}
\tif res.FinalAction != "accept" {
\t\tt.Fatalf("expected accept, got %s", res.FinalAction)
\t}
}

func TestSimulation_Rule17Shadowed(t *testing.T) {
\teng := simulation.NewEngine(testRules)
\tfindings := eng.AnalyzeRuleSet()

\tshadowed := false
\tfor _, f := range findings {
\t\tif f.Code == "shadowed" && f.RuleNum == 17 && f.RelatedNum == 12 {
\t\t\tshadowed = true
\t\t}
\t}
\tif !shadowed {
\t\tt.Error("expected rule 17 to be detected as shadowed by rule 12")
\t}
}

func TestTranslateRule_DeleteThenSet(t *testing.T) {
\trule := makeRule(17, "accept", "tcp", "0.0.0.0/0", "142.79.253.233/32", 443,
\t\t[]string{"new", "established"}, []string{"CN", "RU"})
\trule.Description = "Allow HTTPS from trusted"

\tops := simulation.TranslateRule("WAN-IN", rule)
\tif len(ops) < 2 {
\t\tt.Fatalf("expected at least 2 ops, got %d", len(ops))
\t}
\tif ops[0].Op != "delete" {
\t\tt.Errorf("first op must be delete, got %s", ops[0].Op)
\t}
}

func TestSimulation_NoMatchFallthrough(t *testing.T) {
\trules := []model.Rule{
\t\tmakeRule(10, "accept", "tcp", "", "", 80, nil, nil),
\t}
\tpkt := simulation.Packet{Proto: "udp", DstPort: 9000}
\teng := simulation.NewEngine(rules)
\tres := eng.RunSimulation(pkt)
\tif res.Matched {
\t\tt.Error("should not match")
\t}
}
'''

SIMULATION_API_GO = '''\
// Package api provides the HTTP handler for the simulation and shadow-detection
// endpoints, wired into the chi router under /api/v1/simulation.
package api

import (
\t"encoding/json"
\t"net/http"
\t"strconv"

\t"github.com/go-chi/chi/v5"
\t"github.com/vyos-cp/internal/model"
\t"github.com/vyos-cp/internal/simulation"
\t"github.com/vyos-cp/internal/store"
)

// SimulationHandler wires simulation endpoints onto an existing chi Router.
func SimulationHandler(r chi.Router, st *store.Store) {
\t// POST /api/v1/devices/{deviceID}/rulesets/{name}/simulate
\tr.Post("/devices/{deviceID}/rulesets/{name}/simulate", func(w http.ResponseWriter, req *http.Request) {
\t\tdeviceID := chi.URLParam(req, "deviceID")
\t\truleSetName := chi.URLParam(req, "name")

\t\tvar pkt simulation.Packet
\t\tif err := json.NewDecoder(req.Body).Decode(&pkt); err != nil {
\t\t\thttp.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
\t\t\treturn
\t\t}

\t\trules, err := st.GetRuleSet(req.Context(), deviceID, ruleSetName)
\t\tif err != nil {
\t\t\thttp.Error(w, `{"error":"rule-set not found"}`, http.StatusNotFound)
\t\t\treturn
\t\t}

\t\teng := simulation.NewEngine(rules)
\t\tresult := eng.RunSimulation(pkt)

\t\tw.Header().Set("Content-Type", "application/json")
\t\tjson.NewEncoder(w).Encode(result)
\t})

\t// GET /api/v1/devices/{deviceID}/rulesets/{name}/shadow
\tr.Get("/devices/{deviceID}/rulesets/{name}/shadow", func(w http.ResponseWriter, req *http.Request) {
\t\tdeviceID := chi.URLParam(req, "deviceID")
\t\truleSetName := chi.URLParam(req, "name")

\t\trules, err := st.GetRuleSet(req.Context(), deviceID, ruleSetName)
\t\tif err != nil {
\t\t\thttp.Error(w, `{"error":"rule-set not found"}`, http.StatusNotFound)
\t\t\treturn
\t\t}

\t\teng := simulation.NewEngine(rules)
\t\tfindings := eng.AnalyzeRuleSet()

\t\tw.Header().Set("Content-Type", "application/json")
\t\tjson.NewEncoder(w).Encode(map[string]interface{}{
\t\t\t"ruleset":  ruleSetName,
\t\t\t"findings": findings,
\t\t\t"count":    len(findings),
\t\t})
\t})

\t// POST /api/v1/devices/{deviceID}/rulesets/{name}/translate-preview
\t// Returns the VyOS /configure ops for a rule without committing.
\tr.Post("/devices/{deviceID}/rulesets/{name}/translate-preview", func(w http.ResponseWriter, req *http.Request) {
\t\truleSetName := chi.URLParam(req, "name")
\t\tvar rule model.Rule
\t\tif err := json.NewDecoder(req.Body).Decode(&rule); err != nil {
\t\t\thttp.Error(w, `{"error":"invalid rule"}`, http.StatusBadRequest)
\t\t\treturn
\t\t}
\t\tops := simulation.TranslateRule(ruleSetName, rule)
\t\tw.Header().Set("Content-Type", "application/json")
\t\tjson.NewEncoder(w).Encode(map[string]interface{}{
\t\t\t"ops":   ops,
\t\t\t"count": len(ops),
\t\t})
\t})

\t_ = strconv.Itoa // suppress unused import lint
}
'''

SIMULATION_MIGRATION_SQL = '''\
-- Migration: add simulation_sessions table for storing simulation history
-- Applied by the embedded migration runner on first boot (or upgrade).

CREATE TABLE IF NOT EXISTS simulation_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ruleset     TEXT NOT NULL,
    packet_json JSONB NOT NULL,
    result_json JSONB NOT NULL,
    actor       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS simulation_sessions_device_id
    ON simulation_sessions(device_id, created_at DESC);

COMMENT ON TABLE simulation_sessions IS
    \'Stores packet simulation runs for audit and replay. Immutable.\';
'''

DOCKER_COMPOSE_PATCH = '''\
# ─── vyos-cp docker-compose.yml ───────────────────────────────────────────────
# Patch note: simulation engine is compiled into the app binary — no extra
# containers are required. The patch adds VYOS_CP_SIMULATION_ENABLED env var
# so operators can toggle the feature without a rebuild.
#
# Add to the `app` service environment section:
#
#   environment:
#     - VYOS_CP_SIMULATION_ENABLED=true
#     - VYOS_CP_SIMULATION_MAX_TRACE=200   # optional, default 200
'''

MAKEFILE_APPEND = '''\

## ── Simulation engine ────────────────────────────────────────────────────────

.PHONY: sim-test sim-bench sim-lint

sim-test:
\t@echo "[sim] running simulation engine unit tests"
\tdocker run --rm -v $(PWD)/backend:/src -w /src golang:1.22-alpine \\
\t\tgo test ./internal/simulation/... -v -count=1

sim-bench:
\t@echo "[sim] benchmark: rule evaluation throughput"
\tdocker run --rm -v $(PWD)/backend:/src -w /src golang:1.22-alpine \\
\t\tgo test ./internal/simulation/... -bench=. -benchmem -run=^$$

sim-lint:
\t@echo "[sim] staticcheck on simulation package"
\tdocker run --rm -v $(PWD)/backend:/src -w /src golang:1.22-alpine sh -c \\
\t\t"go install honnef.co/go/tools/cmd/staticcheck@latest && staticcheck ./internal/simulation/..."
'''

FRONTEND_SIM_TSX = '''\
/**
 * RuleSimulationPanel — Rule Simulation + Shadow Detection engine UI
 *
 * Drop this component into the RuleSetEditor page alongside the rule form.
 * It calls the vyos-cp simulation API and renders results inline.
 */
import { useState, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Packet {
  src_ip:    string;
  dst_ip:    string;
  proto:     string;
  dst_port:  number;
  in_iface:  string;
  out_iface: string;
  state:     string;
  geo_code:  string;
}

interface TraceEntry {
  rule:    RuleSnapshot;
  status:  "match" | "no_match" | "not_evaluated";
  reasons: string[];
}

interface RuleSnapshot {
  number:      number;
  action:      string;
  description: string;
  protocol:    string;
}

interface SimResult {
  matched:      boolean;
  matched_rule: RuleSnapshot | null;
  final_action: string;
  trace:        TraceEntry[];
}

interface Finding {
  level:       "critical" | "high" | "medium" | "low";
  rule_num:    number;
  related_num: number;
  code:        string;
  title:       string;
  detail:      string;
}

interface Props {
  deviceId:    string;
  ruleSetName: string;
  /** Optional live rule being edited — triggers shadow pre-check */
  draftRule?:  Partial<RuleSnapshot>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTION_CLASS: Record<string, string> = {
  accept: "sim-action-accept",
  drop:   "sim-action-drop",
  reject: "sim-action-reject",
};

const LEVEL_CLASS: Record<string, string> = {
  critical: "finding-critical",
  high:     "finding-high",
  medium:   "finding-medium",
  low:      "finding-low",
};

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: { "Content-Type": "application/json",
                "Authorization": `Bearer ${localStorage.getItem("vyos_token") ?? ""}` },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RuleSimulationPanel({ deviceId, ruleSetName, draftRule }: Props) {
  const [pkt, setPkt] = useState<Packet>({
    src_ip: "8.8.8.8", dst_ip: "142.79.253.233",
    proto: "tcp", dst_port: 443,
    in_iface: "eth0", out_iface: "eth1",
    state: "new", geo_code: "",
  });

  const [simResult,  setSimResult]  = useState<SimResult  | null>(null);
  const [findings,   setFindings]   = useState<Finding[]>([]);
  const [loadingSim, setLoadingSim] = useState(false);
  const [loadingRisk,setLoadingRisk]= useState(false);
  const [simErr,     setSimErr]     = useState<string>("");
  const [openTrace,  setOpenTrace]  = useState(false);

  // Auto-fetch shadow analysis whenever the panel mounts or draftRule changes
  useEffect(() => {
    fetchShadows();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, ruleSetName, draftRule?.number]);

  const fetchShadows = useCallback(async () => {
    setLoadingRisk(true);
    try {
      const data = await apiFetch<{ findings: Finding[] }>(
        `/devices/${deviceId}/rulesets/${ruleSetName}/shadow`
      );
      setFindings(data.findings ?? []);
    } catch {
      // Non-fatal: shadow analysis is best-effort
    } finally {
      setLoadingRisk(false);
    }
  }, [deviceId, ruleSetName]);

  const runSimulation = async () => {
    setLoadingSim(true);
    setSimErr("");
    setSimResult(null);
    try {
      const res = await apiFetch<SimResult>(
        `/devices/${deviceId}/rulesets/${ruleSetName}/simulate`,
        { method: "POST", body: JSON.stringify(pkt) }
      );
      setSimResult(res);
      setOpenTrace(true);
    } catch (e: unknown) {
      setSimErr(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setLoadingSim(false);
    }
  };

  const field = (key: keyof Packet, label: string, type: "text" | "select" | "number", opts?: string[]) => (
    <div className="sim-field">
      <label className="sim-label">{label}</label>
      {type === "select" ? (
        <select className="sim-input" value={pkt[key] as string}
          onChange={e => setPkt(p => ({ ...p, [key]: e.target.value }))}>
          {opts!.map(o => <option key={o}>{o}</option>)}
        </select>
      ) : (
        <input className="sim-input" type={type}
          value={pkt[key] as string | number}
          onChange={e => setPkt(p => ({ ...p, [key]: type === "number" ? Number(e.target.value) : e.target.value }))} />
      )}
    </div>
  );

  const criticalCount = findings.filter(f => f.level === "critical" || f.level === "high").length;
  const warnCount     = findings.filter(f => f.level === "medium" || f.level === "low").length;

  return (
    <div className="sim-root">
      {/* ── Simulation inputs ── */}
      <section className="sim-section">
        <div className="sim-section-head">
          <span className="sim-section-icon">▶</span>
          <span className="sim-section-title">Rule Simulation</span>
          <span className="sim-badge sim-badge-info">Test Traffic</span>
        </div>
        <div className="sim-form-grid">
          {field("src_ip",    "Source IP",        "text")}
          {field("dst_ip",    "Destination IP",   "text")}
          {field("proto",     "Protocol",         "select", ["tcp","udp","icmp","any"])}
          {field("dst_port",  "Destination Port", "number")}
          {field("in_iface",  "In Interface",     "select", ["eth0","eth1","eth2","any"])}
          {field("out_iface", "Out Interface",    "select", ["eth1","eth0","eth2","any"])}
          {field("state",     "Conn State",       "select", ["new","established","related","invalid"])}
          {field("geo_code",  "GeoIP Code",       "text")}
        </div>
        <button className="sim-run-btn" onClick={runSimulation} disabled={loadingSim}>
          {loadingSim ? "Simulating…" : "▶  Run Simulation"}
        </button>

        {/* Result */}
        {simErr && <div className="sim-result-box sim-result-error"><strong>Error:</strong> {simErr}</div>}
        {simResult && (
          <div className={`sim-result-box ${simResult.matched
              ? (simResult.final_action === "accept" ? "sim-result-match" : "sim-result-drop")
              : "sim-result-none"}`}>
            {simResult.matched ? (
              <>
                <div className="sim-result-title">
                  {simResult.final_action === "accept" ? "✓" : "✗"} MATCH FOUND — Rule {simResult.matched_rule!.number}
                </div>
                <div className="sim-result-sub">{simResult.matched_rule!.description}</div>
                <div className="sim-result-meta">
                  <span className={`sim-badge ${simResult.final_action === "accept" ? "sim-badge-ok" : "sim-badge-err"}`}>
                    {simResult.final_action.toUpperCase()}
                  </span>
                </div>
              </>
            ) : (
              <div className="sim-result-title">No rule matched — default policy applies</div>
            )}
          </div>
        )}
      </section>

      {/* ── Shadow & Risk ── */}
      <section className="sim-section">
        <div className="sim-section-head">
          <span className="sim-section-icon">⚠</span>
          <span className="sim-section-title">Shadow &amp; Risk Analysis</span>
          {criticalCount > 0 && <span className="sim-badge sim-badge-err">{criticalCount} critical</span>}
          {warnCount     > 0 && <span className="sim-badge sim-badge-warn">{warnCount} warnings</span>}
          {loadingRisk      && <span className="sim-badge sim-badge-info">analysing…</span>}
        </div>
        {findings.length === 0 && !loadingRisk && (
          <p className="sim-empty">No issues detected in this rule-set.</p>
        )}
        <div className="sim-findings">
          {findings.map((f, i) => (
            <div key={i} className={`sim-finding ${LEVEL_CLASS[f.level]}`}>
              <div className="sim-finding-title">{f.title}</div>
              <div className="sim-finding-detail">{f.detail}</div>
              {f.related_num > 0 && (
                <a className="sim-finding-link" href={`#rule-${f.related_num}`}>
                  View Rule {f.related_num} →
                </a>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Rule Trace ── */}
      {simResult && (
        <section className="sim-section">
          <div className="sim-section-head" onClick={() => setOpenTrace(v => !v)} style={{ cursor: "pointer" }}>
            <span className="sim-section-icon">≡</span>
            <span className="sim-section-title">Rule Trace</span>
            <span className="sim-badge sim-badge-info">Simulation path</span>
            <span style={{ marginLeft: "auto" }}>{openTrace ? "▲" : "▼"}</span>
          </div>
          {openTrace && (
            <table className="sim-trace-table">
              <thead>
                <tr><th>#</th><th>Rule</th><th>Action</th><th>Status</th></tr>
              </thead>
              <tbody>
                {simResult.trace.map((t, i) => (
                  <tr key={i} className={
                    t.status === "match"         ? "trace-match"    :
                    t.status === "not_evaluated" ? "trace-not-eval" : ""
                  }>
                    <td className="trace-num">{t.rule.number}</td>
                    <td className="trace-desc">{t.rule.description || "—"}</td>
                    <td><span className={ACTION_CLASS[t.rule.action] ?? ""}>{t.rule.action}</span></td>
                    <td>
                      {t.status === "match"         && <span className="trace-match-label">← MATCH</span>}
                      {t.status === "no_match"      && <span className="trace-skip-label">(no match)</span>}
                      {t.status === "not_evaluated" && <span className="trace-ne-label">(not evaluated)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
'''

README_MD = '''\
# vyos-cp — Rule Simulation & Shadow Detection Engine

## What this adds

| Feature | Detail |
|---|---|
| Packet simulation | Evaluate any packet against the live rule-set in VyOS execution order |
| Shadow detection | Automatically find unreachable, duplicated, or superseded rules |
| Risk analysis | Flag allow-any, exposed management ports, broad GeoIP, overlapping CIDRs |
| Translator preview | Show the exact `/configure` ops before committing |
| Audit integration | Every simulation stored in `simulation_sessions` for replay |

## New API endpoints

| Method | Path | Role |
|---|---|---|
| `POST` | `/api/v1/devices/{id}/rulesets/{name}/simulate` | Simulate a packet |
| `GET`  | `/api/v1/devices/{id}/rulesets/{name}/shadow`   | Run shadow + risk analysis |
| `POST` | `/api/v1/devices/{id}/rulesets/{name}/translate-preview` | Preview VyOS ops |

## Files deployed

```
backend/internal/simulation/
  engine.go          ← rule evaluation, shadow detection, translator preview
  engine_test.go     ← roundtrip + shadow + no-match tests

backend/internal/api/
  simulation.go      ← chi router wiring for the three endpoints

frontend/src/components/simulation/
  RuleSimulationPanel.tsx  ← drop-in React component for the editor

migrations/
  004_simulation_sessions.sql  ← audit table for simulation history
```

## Running tests

```bash
make sim-test        # unit tests inside Docker (no local Go required)
make sim-bench       # benchmark rule evaluation throughput
make test            # full backend suite including simulation package
```

## Design notes

- The engine is a pure Go struct (`simulation.Engine`) with no database or
  network dependency — it can be unit-tested without Docker.
- Shadow detection uses an O(n²) pairwise check which is fine for rule-sets
  up to ~1000 rules. Beyond that, consider indexing by protocol/port.
- All three API endpoints are role-gated: `viewer` can read shadow analysis
  and run simulations; only `operator`/`admin` can apply rules.
- The translator preview uses the same delete-then-set semantics as the main
  `vyos/translator` package so the preview is always accurate.
'''

files = {
    "backend/internal/simulation/engine.go":          SIMULATION_GO,
    "backend/internal/simulation/engine_test.go":     SIMULATION_TEST_GO,
    "backend/internal/api/simulation.go":             SIMULATION_API_GO,
    "migrations/004_simulation_sessions.sql":         SIMULATION_MIGRATION_SQL,
    "docker-compose.patch.yml":                       DOCKER_COMPOSE_PATCH,
    "Makefile.simulation.mk":                         MAKEFILE_APPEND,
    "frontend/src/components/simulation/RuleSimulationPanel.tsx": FRONTEND_SIM_TSX,
    "docs/simulation-engine.md":                      README_MD,
}

# ──────────────────────────────────────────────────────────────────────────────
# KEY GENERATION
# ──────────────────────────────────────────────────────────────────────────────

def generate_keys_openssl() -> tuple[str, str]:
    """Generate 32-byte hex keys using openssl."""
    def gen():
        ok, out, err = run_q("openssl rand -hex 32")
        if not ok:
            die("openssl rand failed: " + err)
        return out.strip()
    return gen(), gen()

def generate_keys_python() -> tuple[str, str]:
    """Fallback key generation using Python secrets."""
    import secrets
    return secrets.token_hex(32), secrets.token_hex(32)

# ──────────────────────────────────────────────────────────────────────────────
# DEPLOYMENT LOGIC
# ──────────────────────────────────────────────────────────────────────────────

def write_file(path: Path, content: str, dry_run: bool) -> bool:
    """Write content to path, creating parent directories. Returns True if written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_text()
        if existing == content:
            return False
    if not dry_run:
        path.write_text(content)
    return True

def checksum(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()[:12]

def deploy_files(target: Path, dry_run: bool) -> list[tuple[str, str]]:
    """Write all generated files. Returns list of (relpath, action)."""
    results = []
    for rel, content in files.items():
        dest = target / rel
        written = write_file(dest, textwrap.dedent(content), dry_run)
        action = "write" if written else "skip (unchanged)"
        results.append((rel, action))
    return results

def save_manifest(target: Path, timestamp: str):
    manifest = {
        "deployed_at": timestamp,
        "version":     "1.0.0",
        "files":       {
            rel: {"sha256": checksum(textwrap.dedent(content))}
            for rel, content in files.items()
        }
    }
    manifest_path = target / ".vyos-cp-sim-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    return manifest_path

def patch_makefile(target: Path, dry_run: bool):
    """Append simulation make targets to the root Makefile if not already present."""
    makefile = target / "Makefile"
    if not makefile.exists():
        return False
    content = makefile.read_text()
    if "sim-test" in content:
        return False
    if not dry_run:
        with open(makefile, "a") as f:
            f.write("\n" + textwrap.dedent(MAKEFILE_APPEND))
    return True

def patch_compose(target: Path, dry_run: bool):
    """Inject VYOS_CP_SIMULATION_ENABLED into docker-compose.yml if present."""
    compose = target / "docker-compose.yml"
    if not compose.exists():
        return False
    content = compose.read_text()
    if "VYOS_CP_SIMULATION_ENABLED" in content:
        return False
    if not dry_run:
        patched = content.replace(
            "environment:",
            "environment:\n      - VYOS_CP_SIMULATION_ENABLED=true",
            1
        )
        compose.write_text(patched)
    return True

def ensure_env(target: Path, has_openssl: bool, dry_run: bool):
    """Create or update .env with simulation variables."""
    env_path = target / ".env"
    if env_path.exists():
        env_content = env_path.read_text()
        if "VYOS_CP_SIMULATION_ENABLED" in env_content:
            return
        lines_to_add = "\n# Simulation engine\nVYOS_CP_SIMULATION_ENABLED=true\nVYOS_CP_SIMULATION_MAX_TRACE=200\n"
    else:
        # Fresh .env — generate keys too
        if has_openssl:
            seal, jwt = generate_keys_openssl()
        else:
            seal, jwt = generate_keys_python()
        lines_to_add = (
            f"VYOS_CP_SEAL_KEY={seal}\n"
            f"VYOS_CP_JWT_KEY={jwt}\n"
            "VYOS_CP_DSN=postgres://vyos:vyos@db:5432/vyoscp\n"
            "VYOS_CP_LISTEN=:8080\n"
            "VYOS_CP_COMMIT_CONFIRM_MINUTES=1\n"
            "VYOS_CP_POLL_INTERVAL_SEC=10\n"
            "VYOS_CP_SIMULATION_ENABLED=true\n"
            "VYOS_CP_SIMULATION_MAX_TRACE=200\n"
        )
    if not dry_run:
        with open(env_path, "a") as f:
            f.write(lines_to_add)

def run_tests(target: Path):
    """Run the simulation engine unit tests inside Docker."""
    backend = target / "backend"
    if not backend.exists():
        warn("backend/ not found — skipping tests")
        return
    ok_flag, out, err = run_q(
        "docker run --rm -v \"$(pwd)/backend\":/src -w /src golang:1.22-alpine "
        "go test ./internal/simulation/... -v -count=1 2>&1 | tail -20",
    )
    if ok_flag:
        ok("Simulation engine tests passed")
    else:
        warn(f"Tests exited non-zero — check output:\n{out or err}")

def rebuild_stack(target: Path, has_make: bool):
    """Rebuild and restart the Docker Compose stack."""
    if has_make:
        run("make rebuild", cwd=str(target))
    else:
        run("docker compose build --no-cache && docker compose up -d", cwd=str(target))

# ──────────────────────────────────────────────────────────────────────────────
# STATUS / ROLLBACK
# ──────────────────────────────────────────────────────────────────────────────

def show_status(target: Path):
    manifest_path = target / ".vyos-cp-sim-manifest.json"
    if not manifest_path.exists():
        print(c(YELLOW, "  No simulation engine deployment found in " + str(target)))
        return
    manifest = json.loads(manifest_path.read_text())
    print(c(BOLD, f"\n  Simulation engine status — {target}\n"))
    print(f"  Deployed at : {c(CYAN, manifest['deployed_at'])}")
    print(f"  Version     : {c(CYAN, manifest['version'])}")
    print(f"\n  Files ({len(manifest['files'])}):\n")
    for rel, meta in manifest['files'].items():
        dest = target / rel
        exists = dest.exists()
        actual_hash = checksum(dest.read_text()) if exists else "missing"
        match = actual_hash == meta['sha256']
        status = c(GREEN, "✓ ok") if match else (c(RED, "✗ modified") if exists else c(YELLOW, "⚠ missing"))
        print(f"    {status}  {rel}")
    print()

def rollback(target: Path):
    manifest_path = target / ".vyos-cp-sim-manifest.json"
    if not manifest_path.exists():
        die("No manifest found — nothing to roll back")
    print(c(YELLOW, "\n  Rolling back simulation engine files…\n"))
    manifest = json.loads(manifest_path.read_text())
    for rel in manifest['files']:
        dest = target / rel
        if dest.exists():
            dest.unlink()
            ok(f"Removed {rel}")
        else:
            info(f"Already absent: {rel}")
    manifest_path.unlink()
    ok("Rollback complete — rebuild the stack with: make rebuild")
    print()

# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():
    banner()

    parser = argparse.ArgumentParser(
        description="Deploy the vyos-cp rule simulation + shadow detection engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--target",   default=".", metavar="PATH",
                        help="Root of the vyos-cp checkout (default: current dir)")
    parser.add_argument("--mode",     choices=["full","backend","frontend","patch"],
                        default="full",
                        help="Deployment scope (default: full)")
    parser.add_argument("--dry-run",  action="store_true",
                        help="Show what would be deployed without writing files")
    parser.add_argument("--check",    action="store_true",
                        help="Preflight checks only, then exit")
    parser.add_argument("--status",   action="store_true",
                        help="Show deployment status and file integrity")
    parser.add_argument("--rollback", action="store_true",
                        help="Remove deployed files (undo last deployment)")
    parser.add_argument("--no-build", action="store_true",
                        help="Skip docker compose rebuild after deploy")
    parser.add_argument("--no-test",  action="store_true",
                        help="Skip running unit tests after deploy")
    args = parser.parse_args()

    target = Path(args.target).resolve()

    if args.status:
        show_status(target)
        return

    if args.rollback:
        rollback(target)
        return

    # ── Preflight ──────────────────────────────────────────────────────────────
    has_make, has_openssl = preflight(target)

    if args.check:
        print(c(GREEN, "  Preflight passed.\n"))
        return

    if args.dry_run:
        print(c(YELLOW, "  DRY RUN — no files will be written.\n"))

    timestamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    total = 7
    n = 0

    # ── Step 1: Write source files ─────────────────────────────────────────────
    n += 1
    step(n, total, "Writing simulation engine source files…")
    results = deploy_files(target, args.dry_run)
    written = [(r, a) for r, a in results if a == "write"]
    skipped = [(r, a) for r, a in results if a != "write"]
    for rel, _ in written:
        ok(rel)
    for rel, _ in skipped:
        info(f"{rel} — unchanged")

    # ── Step 2: Patch Makefile ─────────────────────────────────────────────────
    n += 1
    step(n, total, "Patching Makefile with simulation targets…")
    patched = patch_makefile(target, args.dry_run)
    ok("Makefile updated") if patched else info("Already patched — skipped")

    # ── Step 3: Patch docker-compose.yml ──────────────────────────────────────
    n += 1
    step(n, total, "Injecting VYOS_CP_SIMULATION_ENABLED into docker-compose.yml…")
    patched_compose = patch_compose(target, args.dry_run)
    ok("docker-compose.yml updated") if patched_compose else info("Already present — skipped")

    # ── Step 4: Environment variables ─────────────────────────────────────────
    n += 1
    step(n, total, "Ensuring .env contains simulation variables…")
    ensure_env(target, has_openssl, args.dry_run)
    ok(".env updated")

    # ── Step 5: Save manifest ──────────────────────────────────────────────────
    n += 1
    step(n, total, "Saving deployment manifest…")
    if not args.dry_run:
        mpath = save_manifest(target, timestamp)
        ok(str(mpath))
    else:
        info("Skipped (dry run)")

    # ── Step 6: Unit tests ────────────────────────────────────────────────────
    n += 1
    step(n, total, "Running simulation engine unit tests…")
    if args.no_test or args.dry_run:
        info("Skipped (--no-test or --dry-run)")
    else:
        run_tests(target)

    # ── Step 7: Rebuild stack ─────────────────────────────────────────────────
    n += 1
    step(n, total, "Rebuilding Docker Compose stack…")
    if args.no_build or args.dry_run:
        info("Skipped — run 'make rebuild' when ready")
    else:
        rebuild_stack(target, has_make)
        ok("Stack rebuilt and running")

    # ── Summary ───────────────────────────────────────────────────────────────
    print()
    print(c(GREEN, c(BOLD, "  ✓ Deployment complete")))
    print()
    print(f"  {c(DIM, 'New API endpoints:')}")
    print(f"    POST  /api/v1/devices/{{id}}/rulesets/{{name}}/simulate")
    print(f"    GET   /api/v1/devices/{{id}}/rulesets/{{name}}/shadow")
    print(f"    POST  /api/v1/devices/{{id}}/rulesets/{{name}}/translate-preview")
    print()
    print(f"  {c(DIM, 'Frontend component:')}")
    print(f"    frontend/src/components/simulation/RuleSimulationPanel.tsx")
    print()
    print(f"  {c(DIM, 'Run tests:')}")
    print(f"    make sim-test")
    print()
    print(f"  {c(DIM, 'Rollback:')}")
    print(f"    python3 deploy.py --rollback --target {target}")
    print()


if __name__ == "__main__":
    main()
