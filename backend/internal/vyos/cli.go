package vyos

import (
	"fmt"
	"strings"
)

// ToCLI renders a single ConfigureOp as the VyOS configuration-mode command
// an operator would type over SSH. It is the display-only inverse of the op
// array sent to /configure — it does NOT round-trip back through the API.
//
//	{Op:"set", Path:["firewall","ipv4","name","WAN-IN","rule","10","action"], Value:"accept"}
//	  → set firewall ipv4 name WAN-IN rule 10 action accept
//
// The method compares against the underlying string of Op so it stays correct
// whether the caller uses the typed constants (OpSet, OpDelete, …) or a raw
// string literal.
func (o ConfigureOp) ToCLI() string {
	switch string(o.Op) {
	case "set":
		line := "set " + cliJoinPath(o.Path)
		if o.Value != "" {
			line += " " + cliQuoteValue(o.Value)
		}
		return line

	case "delete":
		// Value is meaningless for delete; deleting a node removes its children.
		return "delete " + cliJoinPath(o.Path)

	case "comment":
		// Comment text is always quoted, even when it has no spaces.
		return "comment " + cliJoinPath(o.Path) + " " + cliQuoteForce(o.Value)

	default:
		// Unknown op — surface it as a comment rather than silently dropping,
		// so a bad translator output is visible in the CLI pane.
		return fmt.Sprintf("# unknown op %q: %s %s", string(o.Op), cliJoinPath(o.Path), o.Value)
	}
}

// OpsToCLI renders a batch in order, one command per line. This is the entry
// point the "VyOS CLI" toggle binds to — the same []ConfigureOp the JSON view
// shows, formatted as VyOS CLI commands.
func OpsToCLI(ops []ConfigureOp) string {
	lines := make([]string, len(ops))
	for i, op := range ops {
		lines[i] = op.ToCLI()
	}
	return strings.Join(lines, "\n")
}

// cliJoinPath quotes any individual path segment that contains whitespace.
// VyOS path nodes rarely contain spaces, but rule descriptions promoted into
// paths and some group members can, so we guard every segment.
//
// Named with a cli prefix to avoid colliding with the path-slice-building
// joinPath in package translator.
func cliJoinPath(path []string) string {
	segs := make([]string, len(path))
	for i, s := range path {
		segs[i] = cliQuoteValue(s)
	}
	return strings.Join(segs, " ")
}

// cliQuoteValue wraps a value in double quotes only when it needs it:
// empty string, or contains whitespace or a double quote.
func cliQuoteValue(v string) string {
	if v == "" || strings.ContainsAny(v, " \t\n\"") {
		return cliQuoteForce(v)
	}
	return v
}

// cliQuoteForce always double-quotes and escapes embedded quotes.
func cliQuoteForce(v string) string {
	return `"` + strings.ReplaceAll(v, `"`, `\"`) + `"`
}
