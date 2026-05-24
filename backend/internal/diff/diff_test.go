package diff

import (
	"testing"
)

// equalChanges compares two []Change slices for content equality,
// ignoring slice order if needed. Diff guarantees sorted output, so
// here we just compare slot-by-slot.
func equalChanges(t *testing.T, got, want []Change) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len mismatch: got %d, want %d\ngot:  %+v\nwant: %+v", len(got), len(want), got, want)
	}
	for i := range got {
		if got[i].Path != want[i].Path || got[i].Op != want[i].Op {
			t.Errorf("at [%d]: got {%s %s} want {%s %s}", i, got[i].Path, got[i].Op, want[i].Path, want[i].Op)
		}
	}
}

func TestDiff_Identical(t *testing.T) {
	tree := map[string]any{
		"firewall": map[string]any{
			"ipv4": map[string]any{"name": "WAN-IN"},
		},
	}
	got := Diff(tree, tree)
	if len(got) != 0 {
		t.Fatalf("identical trees should produce no changes, got %d: %+v", len(got), got)
	}
}

func TestDiff_LeafModify(t *testing.T) {
	from := map[string]any{
		"firewall": map[string]any{
			"ipv4": map[string]any{"name": map[string]any{"WAN-IN": map[string]any{"rule": map[string]any{"10": map[string]any{"action": "accept"}}}}},
		},
	}
	to := map[string]any{
		"firewall": map[string]any{
			"ipv4": map[string]any{"name": map[string]any{"WAN-IN": map[string]any{"rule": map[string]any{"10": map[string]any{"action": "drop"}}}}},
		},
	}
	got := Diff(from, to)
	equalChanges(t, got, []Change{
		{Path: "firewall.ipv4.name.WAN-IN.rule.10.action", Op: OpModify},
	})
	if got[0].Before != "accept" || got[0].After != "drop" {
		t.Errorf("before/after wrong: %+v", got[0])
	}
}

func TestDiff_SubtreeAdd(t *testing.T) {
	from := map[string]any{"firewall": map[string]any{}}
	to := map[string]any{
		"firewall": map[string]any{
			"group": map[string]any{
				"address-group": map[string]any{"trusted": map[string]any{"address": []any{"10.0.0.1"}}},
			},
		},
	}
	got := Diff(from, to)
	// Should be a single add at firewall.group, not 4 separate leaf adds —
	// we emit one Change for the entire new sub-tree.
	if len(got) != 1 {
		t.Fatalf("expected 1 add at sub-tree root, got %d: %+v", len(got), got)
	}
	if got[0].Path != "firewall.group" || got[0].Op != OpAdd {
		t.Errorf("expected add at firewall.group, got %+v", got[0])
	}
}

func TestDiff_SubtreeRemove(t *testing.T) {
	from := map[string]any{
		"interfaces": map[string]any{
			"ethernet": map[string]any{"eth3": map[string]any{"description": "spare"}},
		},
	}
	to := map[string]any{"interfaces": map[string]any{"ethernet": map[string]any{}}}
	got := Diff(from, to)
	equalChanges(t, got, []Change{
		{Path: "interfaces.ethernet.eth3", Op: OpRemove},
	})
}

func TestDiff_ArrayElementChange(t *testing.T) {
	from := map[string]any{"members": []any{"a", "b", "c"}}
	to := map[string]any{"members": []any{"a", "B", "c"}}
	got := Diff(from, to)
	equalChanges(t, got, []Change{
		{Path: "members[1]", Op: OpModify},
	})
}

func TestDiff_ArrayLengthChange(t *testing.T) {
	from := map[string]any{"members": []any{"a", "b"}}
	to := map[string]any{"members": []any{"a", "b", "c"}}
	got := Diff(from, to)
	equalChanges(t, got, []Change{
		{Path: "members[2]", Op: OpAdd},
	})
}

func TestDiff_TypeMismatchAtLevel(t *testing.T) {
	// "foo" was a string, became an object. Should emit one modify at that
	// path rather than recursing into mismatched types.
	from := map[string]any{"foo": "bar"}
	to := map[string]any{"foo": map[string]any{"nested": "value"}}
	got := Diff(from, to)
	equalChanges(t, got, []Change{
		{Path: "foo", Op: OpModify},
	})
}

func TestDiff_NilInputs(t *testing.T) {
	// Diff(nil, x) should list everything in x as an add.
	to := map[string]any{"a": 1, "b": 2}
	got := Diff(nil, to)
	if len(got) != 1 || got[0].Op != OpAdd {
		t.Fatalf("expected single sub-tree add, got %+v", got)
	}
}

func TestDiff_DeterministicOrder(t *testing.T) {
	// Same diff computed twice must produce byte-identical output, since
	// the API is paginatable and the UI may diff client-side too.
	from := map[string]any{"z": 1, "a": 2, "m": 3}
	to := map[string]any{"z": 9, "a": 8, "m": 7}
	a := Diff(from, to)
	b := Diff(from, to)
	if len(a) != len(b) {
		t.Fatalf("lengths differ: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Path != b[i].Path {
			t.Errorf("order differs at [%d]: %s vs %s", i, a[i].Path, b[i].Path)
		}
	}
}
