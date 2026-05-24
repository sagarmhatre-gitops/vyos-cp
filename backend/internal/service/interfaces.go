package service

// Test seams for the service layer.
//
// Rationale: the production code historically used the concrete types
// *ClientPool and *vyos.Client directly. That made unit-testing the
// service methods impossible without spinning up a real VyOS device.
// During the IPsec integration we hit a string of bugs that would have
// been caught instantly by a service-level test:
//
//   - Missing "fmt" import in ipsec.go (caught only at docker build time)
//   - service.UpsertPeer wiping the PSK because of an early-return path
//   - DeletePeer not wiping the sibling psk block
//
// These interfaces are deliberately narrow — they expose exactly the
// methods the service layer actually calls. Adding methods here means
// a real dependency exists; don't pad them speculatively.
//
// Production wiring: cmd/vyos-cp/main.go → service.New(...) constructs
// a real *ClientPool and wraps it in clientPoolAdapter so the concrete
// pool satisfies clientPool.
//
// Test wiring: ipsec_service_test.go builds a fakeClientPool that returns
// a fakeClient, with canned Retrieve responses and recorded Configure calls.

import (
	"context"
	"encoding/json"

	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// vyosClient is the slice of *vyos.Client that service methods depend on.
// *vyos.Client satisfies this interface structurally (Go has no `implements`
// keyword — the type just has the matching methods).
type vyosClient interface {
	Configure(ctx context.Context, ops []vyos.ConfigureOp, confirmTime int) error
	Confirm(ctx context.Context) error
	Save(ctx context.Context) error
	Retrieve(ctx context.Context, op vyos.Op, path []string) (json.RawMessage, error)
	Show(ctx context.Context, path []string) (string, error)
	Info(ctx context.Context) (*vyos.Info, error)
	Reboot(ctx context.Context) error
}

// clientPool returns a vyosClient for a given deviceID. The production
// implementation is clientPoolAdapter (below) wrapping *ClientPool.
type clientPool interface {
	Get(ctx context.Context, deviceID string) (vyosClient, error)
}

// clientPoolAdapter wraps *ClientPool to satisfy the clientPool interface.
// All it does is widen the return type from *vyos.Client to vyosClient —
// which is automatic since *vyos.Client implements all the methods.
type clientPoolAdapter struct {
	pool *ClientPool
}

func (a *clientPoolAdapter) Get(ctx context.Context, deviceID string) (vyosClient, error) {
	c, err := a.pool.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	return c, nil
}
