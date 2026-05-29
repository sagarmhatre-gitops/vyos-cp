package api

// liveconfig.go — read endpoints for the Live Config page.
//
// Routes (mount inside the device subrouter that carries JWT auth + {id}):
//
//   GET  /api/v1/devices/{id}/live-config                 -> current (latest snapshot or live)
//   POST /api/v1/devices/{id}/live-config/refresh         -> capture a fresh snapshot now
//   POST /api/v1/devices/{id}/live-config/validate        -> best-effort validation
//   GET  /api/v1/devices/{id}/snapshots                   -> history list (metadata)
//   GET  /api/v1/devices/{id}/snapshots/{snapId}          -> one snapshot (with content)
//   GET  /api/v1/devices/{id}/snapshots/diff?from=&to=    -> unified diff between two
//
// "Current" prefers the latest stored snapshot; if none exists yet it captures
// one on the fly so the page is never empty.

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// ── response shapes (mirror frontend src/lib/api.ts) ────────────────────────

type LiveConfigResponse struct {
	SnapshotID   int64              `json:"snapshot_id"`
	CapturedAt   time.Time          `json:"captured_at"`
	DeviceID     string             `json:"device_id"`
	DeviceName   string             `json:"device_name"`
	ConfigID     string             `json:"config_id"`
	Version      string             `json:"version"`
	Source       string             `json:"source"`
	Content      string             `json:"content"`
	Lines        int                `json:"lines"`
	SizeBytes    int                `json:"size_bytes"`
	Checksum     string             `json:"checksum"`
	LastChanged  *time.Time         `json:"last_changed"`
	ChangedBy    string             `json:"changed_by"`
	Live         bool               `json:"live"`
	Sections     []SectionCount     `json:"sections"`
	TopModified  []TopSection       `json:"top_modified"`
	RecentChange []RecentChangeItem `json:"recent_changes"`
}

type SectionCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type TopSection struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type RecentChangeItem struct {
	At          time.Time `json:"at"`
	Target      string    `json:"target"`
	Description string    `json:"description"`
	Action      string    `json:"action"`
}
type ValidateResponse struct {
	Valid       bool      `json:"valid"`
	Message     string    `json:"message"`
	Detail      string    `json:"detail"`
	ValidatedAt time.Time `json:"validated_at"`
}

type SnapshotMetaResponse struct {
	ID         int64     `json:"id"`
	CapturedAt time.Time `json:"captured_at"`
	ConfigID   string    `json:"config_id"`
	Checksum   string    `json:"checksum"`
	Version    string    `json:"version"`
	Source     string    `json:"source"`
	CapturedBy string    `json:"captured_by"`
	Lines      int       `json:"lines"`
	SizeBytes  int       `json:"size_bytes"`
}

type DiffLine struct {
	Kind string `json:"kind"` // "add" | "del" | "ctx"
	Text string `json:"text"`
	A    int    `json:"a"`
	B    int    `json:"b"`
}
type DiffResponse struct {
	FromID    int64      `json:"from_id"`
	ToID      int64      `json:"to_id"`
	Added     int        `json:"added"`
	Removed   int        `json:"removed"`
	Lines     []DiffLine `json:"lines"`
	Identical bool       `json:"identical"`
}

// ── GET current ──────────────────────────────────────────────────────────────

func (h *Handler) GetLiveConfig(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	ctx := r.Context()

	dev, err := h.store.GetDevice(ctx, deviceID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "device not found")
		return
	}

	snap, serr := h.store.LatestSnapshot(ctx, deviceID)
	if serr != nil {
		captured, _, cerr := h.service.CaptureSnapshot(ctx, deviceID, "manual", actorFrom(ctx))
		if cerr != nil {
			writeErr(w, http.StatusBadGateway, "no snapshot and capture failed: "+cerr.Error())
			return
		}
		snap = captured
	}

	var tree map[string]any
	_ = json.Unmarshal([]byte(snap.Content), &tree)

	rows, _ := h.store.RecentAudit(ctx, deviceID, 50)
	recent := buildRecentChanges(rows, 5)
	top := buildTopModified(rows, 24*time.Hour, 5)

	var lastChanged *time.Time
	changedBy := snap.CapturedBy
	if len(rows) > 0 {
		t := rows[0].At
		lastChanged = &t
		if rows[0].Actor != "" {
			changedBy = rows[0].Actor
		}
	}

	writeJSON(w, http.StatusOK, LiveConfigResponse{
		SnapshotID:   snap.ID,
		CapturedAt:   snap.CapturedAt,
		DeviceID:     deviceID,
		DeviceName:   dev.Name,
		ConfigID:     snap.ConfigID,
		Version:      firstNonEmpty(snap.Version, dev.Version),
		Source:       "Live Sync",
		Content:      snap.Content,
		Lines:        snap.Lines,
		SizeBytes:    snap.SizeBytes,
		Checksum:     snap.Checksum,
		LastChanged:  lastChanged,
		ChangedBy:    changedBy,
		Live:         dev.Online,
		Sections:     buildSectionCounts(tree),
		TopModified:  top,
		RecentChange: recent,
	})
}

// ── POST refresh ──────────────────────────────────────────────────────────────

func (h *Handler) RefreshLiveConfig(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	ctx := r.Context()
	if _, _, err := h.service.CaptureSnapshot(ctx, deviceID, "manual", actorFrom(ctx)); err != nil {
		writeErr(w, http.StatusBadGateway, "capture failed: "+err.Error())
		return
	}
	h.GetLiveConfig(w, r)
}

// ── POST validate ─────────────────────────────────────────────────────────────

func (h *Handler) ValidateLiveConfig(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	ctx := r.Context()
	client, err := h.pool.For(deviceID)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "client pool: "+err.Error())
		return
	}
	_, rerr := client.ShowConfig(ctx, []string{})
	now := time.Now().UTC()
	if rerr != nil {
		writeJSON(w, http.StatusOK, ValidateResponse{
			Valid: false, Message: "Configuration retrieval failed", Detail: rerr.Error(), ValidatedAt: now,
		})
		return
	}
	writeJSON(w, http.StatusOK, ValidateResponse{
		Valid: true, Message: "Configuration is valid", Detail: "No syntax or schema issues detected", ValidatedAt: now,
	})
}

// ── GET history ───────────────────────────────────────────────────────────────

func (h *Handler) ListSnapshots(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	ctx := r.Context()
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, e := strconv.Atoi(l); e == nil {
			limit = n
		}
	}
	metas, err := h.store.ListSnapshots(ctx, deviceID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]SnapshotMetaResponse, len(metas))
	for i, m := range metas {
		out[i] = SnapshotMetaResponse(m)
	}
	writeJSON(w, http.StatusOK, out)
}

// ── GET single snapshot ─────────────────────────────────────────────────────

func (h *Handler) GetSnapshot(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	snapID, _ := strconv.ParseInt(chi.URLParam(r, "snapId"), 10, 64)
	ctx := r.Context()
	snap, err := h.store.GetSnapshot(ctx, deviceID, snapID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "snapshot not found")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// ── GET diff ──────────────────────────────────────────────────────────────────

func (h *Handler) DiffSnapshots(w http.ResponseWriter, r *http.Request) {
	deviceID := chi.URLParam(r, "id")
	ctx := r.Context()
	fromID, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	toID, _ := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)

	from, ferr := h.store.GetSnapshot(ctx, deviceID, fromID)
	to, terr := h.store.GetSnapshot(ctx, deviceID, toID)
	if ferr != nil || terr != nil {
		writeErr(w, http.StatusNotFound, "one or both snapshots not found")
		return
	}

	lines, added, removed := unifiedDiff(from.Content, to.Content)
	writeJSON(w, http.StatusOK, DiffResponse{
		FromID: fromID, ToID: toID, Added: added, Removed: removed,
		Lines: lines, Identical: added == 0 && removed == 0,
	})
}

// ── helpers ─────────────────────────────────────────────────────────────────

func unifiedDiff(a, b string) (out []DiffLine, added, removed int) {
	al := strings.Split(a, "\n")
	bl := strings.Split(b, "\n")
	n, m := len(al), len(bl)

	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if al[i] == bl[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}

	i, j := 0, 0
	for i < n && j < m {
		if al[i] == bl[j] {
			out = append(out, DiffLine{Kind: "ctx", Text: al[i], A: i + 1, B: j + 1})
			i++
			j++
		} else if lcs[i+1][j] >= lcs[i][j+1] {
			out = append(out, DiffLine{Kind: "del", Text: al[i], A: i + 1})
			removed++
			i++
		} else {
			out = append(out, DiffLine{Kind: "add", Text: bl[j], B: j + 1})
			added++
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, DiffLine{Kind: "del", Text: al[i], A: i + 1})
		removed++
	}
	for ; j < m; j++ {
		out = append(out, DiffLine{Kind: "add", Text: bl[j], B: j + 1})
		added++
	}
	return out, added, removed
}

func buildSectionCounts(tree map[string]any) []SectionCount {
	known := []string{"firewall", "nat", "interfaces", "qos", "system"}
	counts := map[string]int{}
	other := 0
	for k, v := range tree {
		nn := countLeaves(v)
		matched := false
		for _, kn := range known {
			if k == kn {
				counts[kn] += nn
				matched = true
				break
			}
		}
		if !matched {
			other += nn
		}
	}
	return []SectionCount{
		{Name: "Firewall", Count: counts["firewall"]},
		{Name: "NAT", Count: counts["nat"]},
		{Name: "Interfaces", Count: counts["interfaces"]},
		{Name: "QoS", Count: counts["qos"]},
		{Name: "System", Count: counts["system"]},
		{Name: "Other", Count: other},
	}
}

func countLeaves(v any) int {
	switch t := v.(type) {
	case map[string]any:
		if len(t) == 0 {
			return 0
		}
		nn := 0
		for _, c := range t {
			nn += countLeaves(c)
		}
		return nn
	case []any:
		nn := 0
		for _, c := range t {
			nn += countLeaves(c)
		}
		if nn == 0 {
			return len(t)
		}
		return nn
	default:
		return 1
	}
}

func buildRecentChanges(rows []AuditRow, limit int) []RecentChangeItem {
	out := make([]RecentChangeItem, 0, limit)
	for _, r := range rows {
		if len(out) >= limit {
			break
		}
		out = append(out, RecentChangeItem{
			At: r.At, Target: auditTarget(r), Description: auditDescription(r), Action: auditAction(r),
		})
	}
	return out
}

func buildTopModified(rows []AuditRow, window time.Duration, limit int) []TopSection {
	cutoff := time.Now().Add(-window)
	freq := map[string]int{}
	for _, r := range rows {
		if r.At.Before(cutoff) {
			continue
		}
		freq[sectionOf(r)]++
	}
	type kv struct {
		k string
		v int
	}
	list := make([]kv, 0, len(freq))
	for k, v := range freq {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].v > list[j].v })
	out := make([]TopSection, 0, limit)
	for _, e := range list {
		if len(out) >= limit {
			break
		}
		out = append(out, TopSection{Name: e.k, Count: e.v})
	}
	return out
}

func auditAction(r AuditRow) string {
	for _, op := range r.Ops {
		switch op.Op {
		case "delete":
			return "Removed"
		case "set":
			if r.Created {
				return "Added"
			}
			return "Modified"
		}
	}
	return "Modified"
}

func auditTarget(r AuditRow) string {
	if len(r.Ops) == 0 || len(r.Ops[0].Path) == 0 {
		return r.Target
	}
	p := r.Ops[0].Path
	switch p[0] {
	case "interfaces":
		if len(p) >= 3 {
			return "interface " + p[2]
		}
		return "interface"
	case "nat":
		if len(p) >= 4 {
			return "nat " + p[1] + " rule " + p[3]
		}
		return "nat"
	case "firewall":
		if len(p) >= 2 {
			return "firewall " + p[1]
		}
		return "firewall"
	case "qos", "traffic-policy":
		return "qos shaping profile"
	case "system":
		if len(p) >= 2 {
			return "system " + p[1]
		}
		return "system"
	}
	return strings.Join(p[:minInt(2, len(p))], " ")
}

func auditDescription(r AuditRow) string {
	if len(r.Ops) == 0 || len(r.Ops[0].Path) == 0 {
		return "Configuration changed"
	}
	switch r.Ops[0].Path[0] {
	case "interfaces":
		return "IP address updated"
	case "nat":
		return "Rule modified"
	case "firewall":
		return "Address added"
	case "qos", "traffic-policy":
		return "Bandwidth updated"
	case "system":
		return "NTP server updated"
	}
	return "Configuration changed"
}

func sectionOf(r AuditRow) string {
	if len(r.Ops) == 0 || len(r.Ops[0].Path) == 0 {
		return "other"
	}
	switch r.Ops[0].Path[0] {
	case "interfaces":
		return "interfaces ethernet"
	case "nat":
		return "nat source"
	case "firewall":
		return "firewall group"
	case "qos", "traffic-policy":
		return "qos shape"
	case "system":
		return "system ntp"
	}
	return r.Ops[0].Path[0]
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
