package vyos

import (
	"fmt"
	"context"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos/parse"
)

// ShowConntrack runs `show conntrack table ipv4` via the VyOS HTTP API /show
// endpoint and parses the returned text table into Flow records.
//
// Uses the client's existing Show primitive (Show(ctx, path) (string, error)),
// which POSTs {op:"show", path:[...]} to /show and returns the data string from
// the {success,data,error} envelope.
func (c *Client) ShowConntrack(ctx context.Context) ([]model.Flow, error) {
	raw, err := c.Show(ctx, []string{"conntrack", "table", "ipv4"})
	if err != nil {
		return nil, fmt.Errorf("show conntrack: %w", err)
	}
	return parse.ParseConntrack(raw), nil
}
