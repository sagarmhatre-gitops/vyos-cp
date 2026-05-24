import { useEffect, useState } from 'react'
import { connectWS, WsEvent, ThroughputSample, IfaceRate } from '../lib/api'

// useLiveCounters subscribes to the WebSocket stream and returns a map of
// "family/ruleset/ruleNum" -> { packets, bytes } for the given device.
// Updates are rebroadcast on every poller tick (default 10s).
export function useLiveCounters(deviceID?: string) {
  const [counters, setCounters] = useState<Record<string, { packets: number; bytes: number }>>({})

  useEffect(() => {
    return connectWS((e: WsEvent) => {
      if (!deviceID || e.device_id !== deviceID) return
      if (e.kind !== 'counters' || !e.counters) return
      const next: Record<string, { packets: number; bytes: number }> = {}
      for (const c of e.counters) {
        next[`${c.family}/${c.ruleset}/${c.rule}`] = {
          packets: c.packets, bytes: c.bytes,
        }
      }
      setCounters(next)
    })
  }, [deviceID])

  return counters
}

// useLiveStatus tracks the last-reported status for all devices.
export function useLiveStatus() {
  const [status, setStatus] = useState<Record<string, string>>({})
  useEffect(() => {
    return connectWS((e: WsEvent) => {
      if (e.kind === 'status' && e.status) {
        setStatus(s => ({ ...s, [e.device_id]: e.status! }))
      }
    })
  }, [])
  return status
}

// Format bytes with SI suffix — 1234567 -> "1.2 MB".
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)} B`
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`
  if (n < 1e12) return `${(n / 1e9).toFixed(2)} GB`
  return `${(n / 1e12).toFixed(2)} TB`
}

// Format packet counts: 842341 -> "842K"
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`
  return `${(n / 1e9).toFixed(2)}B`
}

// useLiveThroughput subscribes to the WebSocket stream and returns a rolling
// buffer of throughput samples for the given device. `maxSamples` caps the
// buffer (matches the backend ring buffer size of 60).
export function useLiveThroughput(deviceID?: string, maxSamples = 60) {
  const [samples, setSamples] = useState<ThroughputSample[]>([])
  useEffect(() => {
    if (!deviceID) return
    setSamples([])
    return connectWS((e: WsEvent) => {
      if (e.device_id !== deviceID || e.kind !== 'throughput' || !e.throughput) return
      setSamples(s => {
        const next = [...s, e.throughput!]
        return next.length > maxSamples ? next.slice(-maxSamples) : next
      })
    })
  }, [deviceID, maxSamples])
  return samples
}

// useFleetThroughput tracks the last-reported throughput aggregated across
// all online devices. Summed as samples arrive.
export function useFleetThroughput() {
  const [perDevice, setPerDevice] = useState<Record<string, IfaceRate>>({})
  useEffect(() => {
    return connectWS((e: WsEvent) => {
      if (e.kind !== 'throughput' || !e.throughput) return
      setPerDevice(m => ({ ...m, [e.device_id]: e.throughput!.total }))
    })
  }, [])
  const agg: IfaceRate = { rx_bps: 0, tx_bps: 0, rx_pps: 0, tx_pps: 0 }
  for (const r of Object.values(perDevice)) {
    agg.rx_bps += r.rx_bps; agg.tx_bps += r.tx_bps
    agg.rx_pps += r.rx_pps; agg.tx_pps += r.tx_pps
  }
  return agg
}
