package service

import (
	"context"
	"sync"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

// ClientPool caches one vyos.Client per device so TLS sessions are reused
// across the REST layer, the poller, and the WebSocket handler.
type ClientPool struct {
	store *store.Store
	mu    sync.RWMutex
	cache map[string]*vyos.Client
}

func NewClientPool(s *store.Store) *ClientPool {
	return &ClientPool{store: s, cache: make(map[string]*vyos.Client)}
}

func (p *ClientPool) Get(ctx context.Context, deviceID string) (*vyos.Client, error) {
	p.mu.RLock()
	c, ok := p.cache[deviceID]
	p.mu.RUnlock()
	if ok {
		return c, nil
	}
	d, key, err := p.store.GetDeviceWithKey(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok = p.cache[deviceID]; ok {
		return c, nil
	}
	c = vyos.New(vyos.Config{
		BaseURL:            d.Address,
		APIKey:             key,
		InsecureSkipVerify: d.InsecureSkipVerify,
		Timeout:            30 * time.Second,
	})
	p.cache[deviceID] = c
	return c, nil
}

// Invalidate drops the cached client — call after a device's API key changes.
func (p *ClientPool) Invalidate(deviceID string) {
	p.mu.Lock()
	delete(p.cache, deviceID)
	p.mu.Unlock()
}
