package vyos

import (
	"sort"
	"strconv"
)

// SynthesizeOps walks an arbitrary VyOS configuration tree and emits the
// `set ...` op array that would recreate it. Order is deterministic:
// alphabetical for normal keys, numeric for all-integer-key maps (e.g.
// firewall rule tables).
//
// Empty objects are treated as leaf nodes (e.g. `loopback.lo = {}` emits
// `set interfaces loopback lo`, because `lo` is a node name, not a key
// holding any further attributes). Scalar arrays expand to one op per
// element. Nested objects recurse.
//
// This is a display-only synthesizer — the output is intended for
// operators to read or paste, not for round-trip to /configure. It does
// not attempt to handle every VyOS edge case; in particular, it doesn't
// distinguish leaf-nodes-with-no-value from container-nodes-that-happen-
// to-be-empty.
func SynthesizeOps(tree map[string]any) []ConfigureOp {
	var ops []ConfigureOp
	walk(tree, nil, &ops)
	return ops
}

// SynthesizeCLI is a convenience: tree → ops → CLI string, joined by \n.
func SynthesizeCLI(tree map[string]any) string {
	return OpsToCLI(SynthesizeOps(tree))
}

// walk recursively emits ops for one subtree.
func walk(v any, path []string, ops *[]ConfigureOp) {
	switch t := v.(type) {
	case map[string]any:
		if len(t) == 0 {
			// Empty object means "this path is a leaf node with no further
			// attributes" — emit a bare `set <path>`. Except at the root:
			// an empty root tree means nothing to render.
			if len(path) == 0 {
				return
			}
			*ops = append(*ops, ConfigureOp{Op: OpSet, Path: cloneSlice(path)})
			return
		}
		for _, k := range sortedKeys(t) {
			// Use a fresh slice each level so sibling recursions don't
			// see each other's path mutations.
			next := make([]string, len(path)+1)
			copy(next, path)
			next[len(path)] = k
			walk(t[k], next, ops)
		}
	case []any:
		// Scalar arrays expand to multiple ops, one per element.
		for _, item := range t {
			leaf(item, path, ops)
		}
	default:
		leaf(t, path, ops)
	}
}

// leaf emits a single `set <path> <value>` op (or just `set <path>` for nil).
func leaf(v any, path []string, ops *[]ConfigureOp) {
	str, ok := scalarString(v)
	if !ok {
		// Unexpected nested structure inside an array — render as a marker
		// so the operator can spot it rather than silently dropping it.
		// Shouldn't happen on real VyOS data.
		str = "<unsupported>"
	}
	op := ConfigureOp{Op: OpSet, Path: cloneSlice(path)}
	if str != "" {
		op.Value = str
	}
	*ops = append(*ops, op)
}

// scalarString turns a JSON scalar into its string form. Returns ok=false
// for non-scalars so the caller can fall back.
func scalarString(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case bool:
		return strconv.FormatBool(x), true
	case float64:
		// JSON numbers always come back as float64 from encoding/json.
		// Most VyOS numeric values are integers (ports, MTUs, rule numbers).
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10), true
		}
		return strconv.FormatFloat(x, 'f', -1, 64), true
	case nil:
		return "", true
	}
	return "", false
}

// sortedKeys returns the keys of m in a stable, human-friendly order:
// numeric order when every key parses as an integer (e.g. rule numbers
// "1","2","10","20"), alphabetical otherwise.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	if allNumeric(keys) {
		sort.Slice(keys, func(i, j int) bool {
			a, _ := strconv.Atoi(keys[i])
			b, _ := strconv.Atoi(keys[j])
			return a < b
		})
	} else {
		sort.Strings(keys)
	}
	return keys
}

func allNumeric(keys []string) bool {
	if len(keys) == 0 {
		return false
	}
	for _, k := range keys {
		if _, err := strconv.Atoi(k); err != nil {
			return false
		}
	}
	return true
}

func cloneSlice(s []string) []string {
	out := make([]string, len(s))
	copy(out, s)
	return out
}
