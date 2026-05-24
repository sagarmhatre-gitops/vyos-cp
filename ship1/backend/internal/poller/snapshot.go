package poller

// This file is a patch sketch for the existing poller.go in
// backend/internal/poller/. The changes are localized and well-scoped:
//
//   1. Add a configurable `snapshotEvery` field on Poller.
//   2. Track a per-device tickCount.
//   3. On every Nth tick, call captureSnapshot in addition to the existing
//      counter poll. Snapshot failures are logged at WARN and never affect
//      counter collection.
//
// Apply by hand against the existing file rather than dropping this in —
// the existing poller has surrounding context (ClientPool reference,
// logger handle, store handle) that varies by your local state of the repo.

import (
	"context"
	"time"

	"vyos-cp/internal/model"
)

// Knobs that should be added to the Poller struct in the existing poller.go:
//
//   type Poller struct {
//       // ... existing fields ...
//       interval        time.Duration  // existing
//       snapshotEvery   uint64         // NEW: number of ticks between snapshots
//   }
//
// Construction reads VYOS_CP_SNAPSHOT_INTERVAL_TICKS from env (default 30).
// At the default poll interval of 10s, 30 ticks = 5 minutes between snapshots.

// runDevice is shown here in its full new form. The existing function should
// be replaced wholesale; the only addition is the snapshot block.
func (p *Poller) runDevice(ctx context.Context, dev model.Device) {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	var tickCount uint64

	// Capture an initial snapshot immediately on startup so the "Live Config"
	// tab has something to render without waiting 5 minutes. If this fails
	// we don't care — the periodic loop will retry.
	p.captureSnapshot(ctx, dev)

	for {
		select {
		case <-ctx.Done():
			return

		case <-ticker.C:
			// Counter polling is unchanged and must always run.
			p.pollCounters(ctx, dev)

			// Snapshot cadence is independent. We use tickCount+1 so that
			// the first periodic snapshot lands after `snapshotEvery` ticks,
			// not on tick 0 (we already snapshotted at startup).
			tickCount++
			if p.snapshotEvery > 0 && tickCount%p.snapshotEvery == 0 {
				p.captureSnapshot(ctx, dev)
			}
		}
	}
}

// captureSnapshot performs one /retrieve, decodes via the translator, and
// persists through the store. All failures are non-fatal: snapshots are a
// health/observability feature and must not affect counter collection.
func (p *Poller) captureSnapshot(ctx context.Context, dev model.Device) {
	// Bounded context so a stalled VyOS doesn't pin a goroutine.
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	client, err := p.pool.For(dev.ID)
	if err != nil {
		p.log.Warn("snapshot: client unavailable", "device", dev.ID, "err", err)
		return
	}

	// RetrieveAll wraps POST /retrieve with showConfig at the root path [].
	// It must use the same wrapped-response unwrapper as ruleset reads so
	// we cope with VyOS 1.5-rolling's outer-key quirk.
	raw, err := client.RetrieveAll(cctx)
	if err != nil {
		p.log.Warn("snapshot: retrieve failed", "device", dev.ID, "err", err)
		return
	}

	cfg, err := p.translator.Decode(raw)
	if err != nil {
		// A decode failure on a live device is interesting — surface at WARN
		// with enough context to debug. Translator should be lossless via
		// DeviceConfig.Extra, so this should be very rare in practice.
		p.log.Warn("snapshot: decode failed", "device", dev.ID, "err", err)
		return
	}

	_, err = p.store.AppendSnapshot(cctx, model.DeviceSnapshot{
		DeviceID: dev.ID,
		Source:   model.SourceDevice,
		Config:   cfg,
	})
	if err != nil {
		p.log.Error("snapshot: persist failed", "device", dev.ID, "err", err)
		return
	}

	// No success log: at ~5min cadence × N devices this would flood. The
	// row in device_snapshots is the receipt.
}
