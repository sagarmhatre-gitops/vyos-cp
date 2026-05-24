// Package poller — throughput collection layer.
// Runs on top of the existing status poller. Once per tick, for each
// online device, collects per-interface byte counters, diffs against the
// previous sample, and broadcasts bps rates via the WebSocket event bus.
package poller

import (
	"context"
	"sync"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/parse"
)

// ThroughputSample is one point in a device's throughput time series.
type ThroughputSample struct {
	Timestamp time.Time                       `json:"ts"`
	Total     IfaceRate                       `json:"total"` // sum across all interfaces
	Per       map[string]IfaceRate            `json:"per"`   // keyed by interface name
}

// IfaceRate is bits-per-second for one interface (or the aggregate).
type IfaceRate struct {
	RXBps uint64 `json:"rx_bps"` // bits per second, not bytes
	TXBps uint64 `json:"tx_bps"`
	RXPps uint64 `json:"rx_pps"` // packets per second
	TXPps uint64 `json:"tx_pps"`
}

// ringBufferSize controls how much per-device history the backend keeps.
// At 10s poll cadence, 60 samples = 10 minutes.
const ringBufferSize = 60

// ThroughputStore holds the last-N samples per device for the sparkline
// UI. Older samples roll off.
type ThroughputStore struct {
	mu      sync.RWMutex
	samples map[string][]ThroughputSample // deviceID -> ring buffer
	// prev holds the last raw counter reading per device+iface so we can diff.
	prev  map[string]map[string]parse.IfaceCounter
	prevT map[string]time.Time
	// lastPersisted is the last timestamp we wrote to Postgres for each device.
	// Used by Run() to decide when the next 60s write boundary has passed.
	lastPersisted map[string]time.Time
}

func NewThroughputStore() *ThroughputStore {
	return &ThroughputStore{
		samples:       map[string][]ThroughputSample{},
		prev:          map[string]map[string]parse.IfaceCounter{},
		prevT:         map[string]time.Time{},
		lastPersisted: map[string]time.Time{},
	}
}

// MarkPersisted records that a sample at t was successfully written to
// persistent storage for the given device.
func (t *ThroughputStore) MarkPersisted(deviceID string, at time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastPersisted[deviceID] = at
}

// DueForPersist returns true if at least `every` time has passed since the
// last successful persist for this device (or never persisted).
func (t *ThroughputStore) DueForPersist(deviceID string, every time.Duration) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	last, ok := t.lastPersisted[deviceID]
	return !ok || time.Since(last) >= every
}

// Latest returns the most recent in-memory sample for a device, or nil.
func (t *ThroughputStore) Latest(deviceID string) *ThroughputSample {
	t.mu.RLock()
	defer t.mu.RUnlock()
	buf := t.samples[deviceID]
	if len(buf) == 0 {
		return nil
	}
	s := buf[len(buf)-1]
	return &s
}

// Collect polls one device for interface counters, diffs against the
// previous sample for that device, appends the resulting rate sample to
// the ring buffer, and returns it. Returns nil on the very first tick
// (no baseline yet to diff against).
func (t *ThroughputStore) Collect(ctx context.Context, deviceID string,
	client *vyos.Client, interfaces []string) *ThroughputSample {

	now := time.Now()
	cur := map[string]parse.IfaceCounter{}
	for _, name := range interfaces {
		// All "eth*" interfaces on current VyOS use "ethernet <name>"; future
		// interface kinds (bond, vlan) follow the same pattern with a
		// different prefix — but counters live at the same level.
		raw, err := client.Show(ctx, []string{"interfaces", "ethernet", name})
		if err != nil {
			continue
		}
		cur[name] = parse.ShowInterfacesStats(name, raw)
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	prev, havePrev := t.prev[deviceID]
	prevT := t.prevT[deviceID]
	t.prev[deviceID] = cur
	t.prevT[deviceID] = now

	if !havePrev || prevT.IsZero() {
		return nil // no baseline; wait for next tick
	}
	dt := now.Sub(prevT).Seconds()
	if dt < 0.1 {
		return nil // avoid division by tiny intervals
	}

	sample := ThroughputSample{
		Timestamp: now,
		Per:       map[string]IfaceRate{},
	}
	for name, c := range cur {
		p, ok := prev[name]
		if !ok {
			continue
		}
		rate := IfaceRate{
			RXBps: rateBps(c.RXBytes, p.RXBytes, dt),
			TXBps: rateBps(c.TXBytes, p.TXBytes, dt),
			RXPps: ratePps(c.RXPkts, p.RXPkts, dt),
			TXPps: ratePps(c.TXPkts, p.TXPkts, dt),
		}
		sample.Per[name] = rate
		sample.Total.RXBps += rate.RXBps
		sample.Total.TXBps += rate.TXBps
		sample.Total.RXPps += rate.RXPps
		sample.Total.TXPps += rate.TXPps
	}

	// Append to ring buffer.
	buf := t.samples[deviceID]
	buf = append(buf, sample)
	if len(buf) > ringBufferSize {
		buf = buf[len(buf)-ringBufferSize:]
	}
	t.samples[deviceID] = buf

	return &sample
}

// History returns the ring buffer for a device (newest last).
func (t *ThroughputStore) History(deviceID string) []ThroughputSample {
	t.mu.RLock()
	defer t.mu.RUnlock()
	src := t.samples[deviceID]
	out := make([]ThroughputSample, len(src))
	copy(out, src)
	return out
}

// AggregateLatest returns the most recent sample across all devices,
// summed. Used by the dashboard fleet-total tile.
func (t *ThroughputStore) AggregateLatest() IfaceRate {
	t.mu.RLock()
	defer t.mu.RUnlock()
	var agg IfaceRate
	for _, buf := range t.samples {
		if len(buf) == 0 {
			continue
		}
		last := buf[len(buf)-1]
		agg.RXBps += last.Total.RXBps
		agg.TXBps += last.Total.TXBps
		agg.RXPps += last.Total.RXPps
		agg.TXPps += last.Total.TXPps
	}
	return agg
}

func rateBps(now, prev uint64, dt float64) uint64 {
	if now < prev {
		return 0 // counter wrap or reset
	}
	return uint64(float64((now-prev)*8) / dt)
}

func ratePps(now, prev uint64, dt float64) uint64 {
	if now < prev {
		return 0
	}
	return uint64(float64(now-prev) / dt)
}
