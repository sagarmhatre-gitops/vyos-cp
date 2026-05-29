package vyos

import "testing"

// The tests cast string literals to Op explicitly. Real callers will normally
// use the typed constants (OpSet, OpDelete, …), but the formatter compares
// against the underlying string so both styles work.

func TestConfigureOp_ToCLI(t *testing.T) {
	tests := []struct {
		name string
		op   ConfigureOp
		want string
	}{
		{
			name: "set with value",
			op:   ConfigureOp{Op: Op("set"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10", "action"}, Value: "accept"},
			want: "set firewall ipv4 name WAN-IN rule 10 action accept",
		},
		{
			name: "set valueless node",
			op:   ConfigureOp{Op: Op("set"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10", "log"}},
			want: "set firewall ipv4 name WAN-IN rule 10 log",
		},
		{
			name: "delete ignores value",
			op:   ConfigureOp{Op: Op("delete"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10"}, Value: "ignored"},
			want: "delete firewall ipv4 name WAN-IN rule 10",
		},
		{
			name: "value with spaces is quoted",
			op:   ConfigureOp{Op: Op("set"), Path: []string{"interfaces", "ethernet", "eth0", "description"}, Value: "office uplink"},
			want: `set interfaces ethernet eth0 description "office uplink"`,
		},
		{
			name: "comment text always quoted",
			op:   ConfigureOp{Op: Op("comment"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10"}, Value: "temporary - remove after migration"},
			want: `comment firewall ipv4 name WAN-IN rule 10 "temporary - remove after migration"`,
		},
		{
			name: "embedded quote is escaped",
			op:   ConfigureOp{Op: Op("set"), Path: []string{"system", "login", "banner", "post-login"}, Value: `say "hi"`},
			want: `set system login banner post-login "say \"hi\""`,
		},
		{
			name: "unknown op surfaced as comment",
			op:   ConfigureOp{Op: Op("rename"), Path: []string{"firewall", "group"}, Value: "x"},
			want: `# unknown op "rename": firewall group x`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.op.ToCLI(); got != tt.want {
				t.Errorf("ToCLI()\n got: %s\nwant: %s", got, tt.want)
			}
		})
	}
}

func TestOpsToCLI_DeleteThenSet(t *testing.T) {
	// Mirrors the translator's delete-then-set output for a rule edit.
	ops := []ConfigureOp{
		{Op: Op("delete"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10"}},
		{Op: Op("set"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10", "action"}, Value: "accept"},
		{Op: Op("set"), Path: []string{"firewall", "ipv4", "name", "WAN-IN", "rule", "10", "protocol"}, Value: "tcp"},
	}
	want := "delete firewall ipv4 name WAN-IN rule 10\n" +
		"set firewall ipv4 name WAN-IN rule 10 action accept\n" +
		"set firewall ipv4 name WAN-IN rule 10 protocol tcp"

	if got := OpsToCLI(ops); got != want {
		t.Errorf("OpsToCLI()\n got:\n%s\nwant:\n%s", got, want)
	}
}
