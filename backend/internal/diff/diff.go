// Package diff computes structural differences between two decoded VyOS
// configuration trees, expressed as a flat list of leaf-level changes.
//
// Design choices:
//
//   - Diffs operate on the OPAQUE config tree (whatever the device returned,
//     stored in DeviceConfig.Extra). We deliberately do not consult the
//     translator: a diff that only covers translator-modeled sections would
//     silently ignore drift in everything else (system settings, services,
//     etc.) — exactly the kind of drift operators most want to catch.
//
//   - The output is a flat slice of Change entries keyed by dotted path
//     (e.g. "firewall.ipv4.name.WAN-IN.rule.10.action"). This makes the
//     wire format trivially filterable on the client side ("show only
//     firewall.*") and keeps the API surface tiny.
//
//   - Arrays are compared by index, not by content. VyOS arrays usually
//     have semantic ordering (priority, rule numbers) — treating them as
//     sets would conflate "I added a new address to the group" with "I
//     reordered the addresses". Index-based diff is occasionally chatty
//     when an item is inserted at the head, but it never misleads.
package diff

import (
	"fmt"
	"sort"
	"strings"
)

// Op classifies a leaf change.
type Op string

const (
	OpAdd    Op = "add"
	OpRemove Op = "remove"
	OpModify Op = "modify"
)

// Change is a single leaf-level difference between two trees.
//
// Path is dotted, with array indices in square brackets:
//   "firewall.ipv4.name.WAN-IN.rule.10.action"
//   "firewall.group.address-group.trusted.address[2]"
//
// Before/After hold the leaf values. For container-level adds and removes
// (a whole new sub-tree appeared or disappeared) we still emit a single
// Change at the container path with the sub-tree as the value, rather than
// fanning out into hundreds of leaf changes. The UI is responsible for
// rendering nested values when they appear.
type Change struct {
	Path   string `json:"path"`
	Op     Op     `json:"op"`
	Before any    `json:"before,omitempty"`
	After  any    `json:"after,omitempty"`
}

// Diff produces the list of changes that transform `from` into `to`.
// Both inputs are expected to be the decoded config trees (typically
// map[string]any roots). Nil on either side is treated as an empty tree,
// so Diff(nil, x) lists everything in x as additions.
func Diff(from, to any) []Change {
	var out []Change
	walk("", from, to, &out)
	// Stable ordering makes the API output deterministic and the UI
	// rendering predictable — critical for "did Ship 2 just regress?"
	// tests.
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// walk recursively compares two values at a given path prefix.
// One level of recursion per nesting level of the deeper tree.
func walk(prefix string, a, b any, out *[]Change) {
	// Both nil / both missing: nothing to report.
	if a == nil && b == nil {
		return
	}

	// One side missing: whole sub-tree is an add or a remove, emit a
	// single Change rather than recursing. The UI renders the value.
	if a == nil {
		*out = append(*out, Change{Path: prefix, Op: OpAdd, After: b})
		return
	}
	if b == nil {
		*out = append(*out, Change{Path: prefix, Op: OpRemove, Before: a})
		return
	}

	// Type mismatch (e.g. became an object instead of a string): treat as
	// modify at this level — recursing into mismatched types only produces
	// noise.
	if typeKind(a) != typeKind(b) {
		*out = append(*out, Change{Path: prefix, Op: OpModify, Before: a, After: b})
		return
	}

	switch va := a.(type) {
	case map[string]any:
		vb := b.(map[string]any)
		// Walk the union of keys so we catch both adds (in b only) and
		// removes (in a only). Sorted keys give us deterministic
		// recursion order, which together with the final sort makes
		// Diff stable.
		keys := unionKeys(va, vb)
		for _, k := range keys {
			walk(joinPath(prefix, k), va[k], vb[k], out)
		}
	case []any:
		vb := b.([]any)
		// Compare element-by-element. Out-of-range on either side is
		// treated as nil so it falls into add/remove cleanly.
		n := len(va)
		if len(vb) > n {
			n = len(vb)
		}
		for i := 0; i < n; i++ {
			var av, bv any
			if i < len(va) {
				av = va[i]
			}
			if i < len(vb) {
				bv = vb[i]
			}
			walk(fmt.Sprintf("%s[%d]", prefix, i), av, bv, out)
		}
	default:
		// Scalar: compare directly.
		if !scalarEqual(a, b) {
			*out = append(*out, Change{Path: prefix, Op: OpModify, Before: a, After: b})
		}
	}
}

// typeKind reduces a value to a coarse type tag so we can detect "the
// shape changed entirely" (object -> array, etc.) without comparing
// element by element.
func typeKind(v any) string {
	switch v.(type) {
	case map[string]any:
		return "object"
	case []any:
		return "array"
	default:
		return "scalar"
	}
}

func unionKeys(a, b map[string]any) []string {
	seen := make(map[string]struct{}, len(a)+len(b))
	for k := range a {
		seen[k] = struct{}{}
	}
	for k := range b {
		seen[k] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// joinPath appends a key to a dotted prefix. Empty prefix means root.
// If a key itself contains a dot (rare in VyOS but possible in extra
// metadata), we wrap it in brackets so the output remains parseable.
func joinPath(prefix, key string) string {
	if strings.ContainsAny(key, ".[]") {
		key = "[" + key + "]"
	}
	if prefix == "" {
		return key
	}
	if strings.HasPrefix(key, "[") {
		return prefix + key
	}
	return prefix + "." + key
}

// scalarEqual compares two scalar values. JSON unmarshaling makes all
// numbers float64, so direct == is fine for everything we expect.
func scalarEqual(a, b any) bool {
	return a == b
}
