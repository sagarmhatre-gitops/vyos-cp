// Package poller runs background health + counter refresh for all devices,
// broadcasting updates to WebSocket subscribers.
package poller

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/store"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/parse"
)

// jsonUnmarshal aliases json.Unmarshal so imports stay tidy.
var jsonUnmarshal = json.Unmarshal

type Event struct {
	DeviceID   string            `json:"device_id"`
	Kind       string            `json:"kind"` // "status" | "counters" | "throughput"
	Status     string            `json:"status,omitempty"`
	Version    string            `json:"version,omitempty"`
	Hostname   string            `json:"hostname,omitempty"`
	Counters   []parse.Counter   `json:"counters,omitempty"`
	Throughput *ThroughputSample `json:"throughput,omitempty"`
	Ts         time.Time         `json:"ts"`
}

// MetricsCollector is the narrow interface the poller uses to ask "someone"
// (in practice, the service layer) to gather + persist a metrics sample for
// a device. We keep this as a tiny interface rather than importing the
// service package directly to preserve the dependency direction:
//   service -> store
//   poller  -> store
//   server  -> service, poller
// If poller imported service we'd risk a cycle later when service grows
// poller-aware features (e.g. live status pubsub).
type MetricsCollector interface {
	CollectAndStoreMetrics(ctx context.Context, deviceID string) error
}

type Poller struct {
	store     *store.Store
	getClient func(ctx context.Context, id string) (*vyos.Client, error)
	interval  time.Duration

	// metrics is optional: nil means we just don't collect device-level
	// CPU/memory/session samples. Throughput polling continues either way.
	metrics MetricsCollector

	mu   sync.RWMutex
	subs map[chan Event]struct{}

	// Thru is the public throughput store; the HTTP layer reads from it
	// to serve /api/v1/devices/{id}/throughput (history) and the dashboard
	// aggregate tile.
	Thru *ThroughputStore

	// Snapshot capture cadence. Zero disables automatic capture (manual
	// POST /snapshot still works). Read once at construction from
	// VYOS_CP_SNAPSHOT_INTERVAL_TICKS; default 30 (= 5 min at 10s ticks).
	snapshotEveryTicks  uint64
	snapshotTickCounter sync.Map // map[deviceID]*uint64
}

func New(s *store.Store, get func(ctx context.Context, id string) (*vyos.Client, error), interval time.Duration) *Poller {
	return &Poller{
		store: s, getClient: get, interval: interval,
		subs: make(map[chan Event]struct{}),
		Thru: NewThroughputStore(),
		snapshotEveryTicks: readSnapshotEveryTicks(),
	}
}

// SetMetricsCollector wires a collector after construction. Called from
// main.go once the service is built. Optional — the poller works fine
// without one (just no metrics history).
func (p *Poller) SetMetricsCollector(m MetricsCollector) {
	p.metrics = m
}

func (p *Poller) Run(ctx context.Context) {
	// Kick the retention job on startup and then hourly.
	go p.retentionLoop(ctx)

	// Device metrics (CPU, memory, sessions) sample at minute granularity.
	// Independent of the fast status/throughput tick so we don't hammer the
	// device with op-mode show calls every 10s — once a minute is plenty
	// for resource-pressure history.
	go p.metricsLoop(ctx)

	// Tick once immediately so the dashboard isn't blank for 10s.
	p.tick(ctx)
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick(ctx)
		}
	}
}

// metricsLoop runs once a minute, fanning out across all online devices to
// collect a CPU/memory/session sample. Stays passive (no work) when no
// MetricsCollector has been wired.
func (p *Poller) metricsLoop(ctx context.Context) {
	if p.metrics == nil {
		return
	}
	collect := func() {
		devices, err := p.store.ListDevices(ctx)
		if err != nil {
			log.Printf("metrics: list: %v", err)
			return
		}
		for _, d := range devices {
			if d.Status != "online" {
				continue // offline devices won't answer the show calls; skip
			}
			id := d.ID
			go func() {
				cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				defer cancel()
				if err := p.metrics.CollectAndStoreMetrics(cctx, id); err != nil {
					log.Printf("metrics: device=%s err: %v", id, err)
				}
			}()
		}
	}
	// Wait 30 seconds before first sample so the device has time to
	// transition to "online" if it just came up. Avoids a spurious "no
	// data" gap at the start of the chart.
	select {
	case <-ctx.Done():
		return
	case <-time.After(30 * time.Second):
	}
	collect()
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			collect()
		}
	}
}

// retentionLoop prunes throughput_samples older than 30 days. Cheap query
// because of the ts index. Runs at startup and once per hour thereafter.
func (p *Poller) retentionLoop(ctx context.Context) {
	run := func() {
		cutoff := time.Now().Add(-30 * 24 * time.Hour)
		n, err := p.store.PruneThroughput(ctx, cutoff)
		if err != nil {
			log.Printf("retention: prune throughput err: %v", err)
		} else if n > 0 {
			log.Printf("retention: pruned %d throughput samples older than 30d", n)
		}
		m, err := p.store.PruneDeviceMetrics(ctx, cutoff)
		if err != nil {
			log.Printf("retention: prune metrics err: %v", err)
		} else if m > 0 {
			log.Printf("retention: pruned %d device-metric rows older than 30d", m)
		}
	}
	run()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

func (p *Poller) tick(ctx context.Context) {
	devices, err := p.store.ListDevices(ctx)
	if err != nil {
		log.Printf("poller: list: %v", err)
		return
	}
	var wg sync.WaitGroup
	for _, d := range devices {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			p.pollOne(ctx, id)
		}(d.ID)
	}
	wg.Wait()
}

func (p *Poller) pollOne(ctx context.Context, deviceID string) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	client, err := p.getClient(ctx, deviceID)
	if err != nil {
		_ = p.store.UpdateDeviceStatus(ctx, deviceID, "offline", "", "", err.Error())
		p.broadcast(Event{DeviceID: deviceID, Kind: "status", Status: "offline", Ts: time.Now()})
		return
	}

	info, err := client.Info(ctx)
	if err != nil {
		_ = p.store.UpdateDeviceStatus(ctx, deviceID, "offline", "", "", err.Error())
		p.broadcast(Event{DeviceID: deviceID, Kind: "status", Status: "offline", Ts: time.Now()})
		return
	}
	_ = p.store.UpdateDeviceStatus(ctx, deviceID, "online", info.Version, info.Hostname, "")
	p.broadcast(Event{
		DeviceID: deviceID, Kind: "status", Status: "online",
		Version: info.Version, Hostname: info.Hostname, Ts: time.Now(),
	})

	var all []parse.Counter
	for _, family := range []string{"ipv4", "ipv6"} {
		out, err := client.Show(ctx, []string{"firewall", family})
		if err != nil {
			continue
		}
		all = append(all, parse.ShowFirewall(out)...)
	}
	if len(all) > 0 {
		p.broadcast(Event{DeviceID: deviceID, Kind: "counters", Counters: all, Ts: time.Now()})
	}

	// Throughput — fetch interface list from config, then query per-ethernet
	// counters, diff against previous tick, broadcast bits-per-second.
	ifaces, err := p.listEthernetNames(ctx, client)
	if err != nil {
		log.Printf("poller: device=%s list-ethernet err: %v", deviceID, err)
	} else if len(ifaces) > 0 {
		log.Printf("poller: device=%s polling throughput for ifaces=%v", deviceID, ifaces)
		if sample := p.Thru.Collect(ctx, deviceID, client, ifaces); sample != nil {
			p.broadcast(Event{
				DeviceID: deviceID, Kind: "throughput",
				Throughput: sample, Ts: time.Now(),
			})
			// Persist once per minute; in-memory ring still ticks every poll.
			if p.Thru.DueForPersist(deviceID, 60*time.Second) {
				perJSON, _ := json.Marshal(sample.Per)
				row := store.ThroughputRow{
					DeviceID:  deviceID,
					Timestamp: sample.Timestamp.Truncate(time.Minute),
					RXBps:     sample.Total.RXBps,
					TXBps:     sample.Total.TXBps,
					RXPps:     sample.Total.RXPps,
					TXPps:     sample.Total.TXPps,
					PerIface:  perJSON,
				}
				if err := p.store.InsertThroughput(ctx, row); err != nil {
					log.Printf("poller: device=%s persist err: %v", deviceID, err)
				} else {
					p.Thru.MarkPersisted(deviceID, time.Now())
				}
			}
		}
	}

	p.maybeCaptureSnapshot(ctx, deviceID, client)
}

// listEthernetNames pulls the ethernet interface names from config so the
// throughput collector knows which to poll. VyOS 1.5-rolling wraps /retrieve
// responses with the last path segment as an outer key, so we request the
// parent and unwrap one level.
func (p *Poller) listEthernetNames(ctx context.Context, client *vyos.Client) ([]string, error) {
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces"})
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var tree map[string]map[string]interface{}
	if err := jsonUnmarshal(raw, &tree); err != nil {
		return nil, err
	}
	eth, ok := tree["ethernet"]
	if !ok {
		return nil, nil
	}
	names := make([]string, 0, len(eth))
	for k := range eth {
		names = append(names, k)
	}
	return names, nil
}

func (p *Poller) Subscribe() chan Event {
	ch := make(chan Event, 64)
	p.mu.Lock()
	p.subs[ch] = struct{}{}
	p.mu.Unlock()
	return ch
}

func (p *Poller) Unsubscribe(ch chan Event) {
	p.mu.Lock()
	delete(p.subs, ch)
	p.mu.Unlock()
	close(ch)
}

func (p *Poller) broadcast(e Event) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for ch := range p.subs {
		select {
		case ch <- e:
		default:
			// Drop for slow subscribers rather than block.
		}
	}
}
