package poller

import "github.com/vyos-cp/vyos-cp/internal/vyos/parse"

// RawCounters returns a copy of the most recent raw cumulative counters per
// interface for a device (the same readings the rate collector diffs). Used by
// the counter-snapshot persistence path. Returns nil if no reading yet.
func (t *ThroughputStore) RawCounters(deviceID string) map[string]parse.IfaceCounter {
	t.mu.RLock()
	defer t.mu.RUnlock()
	src, ok := t.prev[deviceID]
	if !ok {
		return nil
	}
	out := make(map[string]parse.IfaceCounter, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}
