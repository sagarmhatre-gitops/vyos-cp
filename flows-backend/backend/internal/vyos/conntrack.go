package vyos

import (
	"context"
	"fmt"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos/parse"
)

// ShowConntrack runs `show conntrack table ipv4` via the VyOS HTTP API /show
// endpoint and parses the returned text table into Flow records.
//
// This relies on the client's existing op-mode show primitive. The method name
// of that primitive differs across codebases; this calls `c.showOp` which is
// expected to POST {op:"show", path:[...]} to /show and return the `data` string
// from the {success,data,error} envelope. If your client's primitive is named
// differently (e.g. c.Show, c.opShow, c.runShow), rename the call below to match
// — see NOTES.md "client primitive" section.
func (c *Client) ShowConntrack(ctx context.Context) ([]model.Flow, error) {
	raw, err := c.showOp(ctx, []string{"conntrack", "table", "ipv4"})
	if err != nil {
		return nil, fmt.Errorf("show conntrack: %w", err)
	}
	return parse.ParseConntrack(raw), nil
}
