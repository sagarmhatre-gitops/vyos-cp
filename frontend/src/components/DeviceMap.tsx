// DeviceMap — inline SVG world map with markers per device.
//
// This is a deliberately minimal map: ~80 lines of SVG with a simplified
// world outline + dots positioned via Mercator-ish projection. We chose
// inline SVG over Leaflet to avoid an npm dependency, an external tile
// fetch, and CSP complications. For fleets up to ~50 devices the visual
// signal is the same; if the fleet grows beyond that we'd want pan/zoom
// and Leaflet becomes worth its weight.
//
// Coordinates come from an IP→geolocation lookup. We hit ipapi.co (free,
// no key) and cache results in localStorage for 24 hours per IP. The
// cache prevents the rate limit becoming a problem and makes repeat
// renders instant.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Device } from '../lib/api'

type GeoPoint = { lat: number; lon: number; city?: string; country?: string }

// --- Geo cache --------------------------------------------------------------

const CACHE_KEY = 'vyos-cp.geo'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

type CacheEntry = { at: number; point: GeoPoint | null }

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function writeCache(c: Record<string, CacheEntry>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch { /* ignore */ }
}

/** Best-effort IP geolocation via ipapi.co. Returns null on private IPs or
 *  on lookup failure rather than throwing — we don't want the map to crash
 *  the page just because one geo request 429'd. */
async function geoLookup(ip: string): Promise<GeoPoint | null> {
  // Skip RFC1918 / link-local / loopback — they have no public location.
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|169\.254\.|::1)/.test(ip)) {
    return null
  }
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`)
    if (!r.ok) return null
    const j = await r.json()
    if (typeof j.latitude !== 'number' || typeof j.longitude !== 'number') return null
    return { lat: j.latitude, lon: j.longitude, city: j.city, country: j.country_name }
  } catch { return null }
}

/** Extract a usable IP (or hostname) from a device's address URL. We strip
 *  scheme/path/port; what's left is the host or IP we look up. */
function hostFromAddress(addr?: string): string {
  if (!addr) return ''
  try {
    const u = new URL(addr)
    return u.hostname
  } catch {
    // Bare host, no scheme — strip slashes / paths defensively.
    return addr.replace(/^\/+|\/+$/g, '').split('/')[0].split(':')[0]
  }
}

// --- Projection -------------------------------------------------------------

// Map view dimensions — chosen to match a 2:1 equirectangular ratio so the
// projection math stays simple. Two presets: compact (KPI panel) and full
// (standalone map page). Width is set by the parent grid; we just enforce
// the SVG aspect via viewBox.
const W = 720
const H = 360

/** Equirectangular projection: lat [−90,90] / lon [−180,180] → SVG pixels.
 *  Not as nice as Mercator at high latitudes but trivial to compute and
 *  accurate enough for a fleet-overview signal. */
function project(lat: number, lon: number): { x: number; y: number } {
  const x = ((lon + 180) / 360) * W
  const y = ((90 - lat) / 180) * H
  return { x, y }
}

// --- Component --------------------------------------------------------------

type Marker = {
  device: Device
  point: GeoPoint
  x: number
  y: number
}

export function DeviceMap({ devices, compact }: { devices: Device[]; compact?: boolean }) {
  // Resolved markers; null geo = not placeable.
  const [markers, setMarkers] = useState<Marker[]>([])
  const [unplaced, setUnplaced] = useState(0)

  // IP set used for the geo lookup effect — derive once so we don't refetch
  // when the parent re-renders for unrelated reasons.
  const ips = useMemo(() => {
    return [...new Set((devices || []).map(d => hostFromAddress(d.address)).filter(Boolean))]
  }, [devices])

  useEffect(() => {
    let alive = true
    const cache = readCache()
    const now = Date.now()
    const points: Record<string, GeoPoint | null> = {}

    // Hydrate from cache synchronously.
    for (const ip of ips) {
      const e = cache[ip]
      if (e && now - e.at < CACHE_TTL_MS) points[ip] = e.point
    }

    // Apply what we have.
    apply(points)

    // Fetch any misses, with throttling so a bulk dashboard load doesn't
    // burst the rate limit. 200ms gap between requests is gentle.
    ;(async () => {
      for (const ip of ips) {
        if (ip in points) continue
        const p = await geoLookup(ip)
        if (!alive) return
        cache[ip] = { at: Date.now(), point: p }
        points[ip] = p
        apply(points)
        await new Promise(res => setTimeout(res, 200))
      }
      writeCache(cache)
    })()

    function apply(pts: Record<string, GeoPoint | null>) {
      const placed: Marker[] = []
      let missing = 0
      for (const d of devices || []) {
        const ip = hostFromAddress(d.address)
        const p = pts[ip]
        if (p) {
          const { x, y } = project(p.lat, p.lon)
          placed.push({ device: d, point: p, x, y })
        } else if (p === null) {
          missing++
        } // undefined means "not yet looked up"; don't count as missing
      }
      if (alive) {
        setMarkers(placed)
        setUnplaced(missing)
      }
    }

    return () => { alive = false }
  }, [ips, devices])

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Device map</span>
        <span className="dim" style={{ fontSize: 11 }}>
          {markers.length} placed{unplaced > 0 ? ` · ${unplaced} private` : ''}
        </span>
      </div>
      <div style={{ padding: compact ? 6 : 8 }}>
        <svg viewBox={`0 0 ${W} ${H}`}
          width="100%" preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', background: 'var(--bg-subtle)', borderRadius: 4 }}>
          {/* Subtle world outline — simplified as a stylized landmass mass.
             Not geographically perfect; visually identifies the world without
             needing a TopoJSON of country borders. */}
          <WorldOutline />

          {/* Equator + prime-meridian guide lines — very faint */}
          <line x1={0} y1={H/2} x2={W} y2={H/2} stroke="var(--line)" strokeWidth={0.5} opacity={0.5} />
          <line x1={W/2} y1={0} x2={W/2} y2={H} stroke="var(--line)" strokeWidth={0.5} opacity={0.5} />

          {/* Markers — pulsing dot for online, static for offline. Stagger
             pulses so multiple devices don't blink in lockstep. */}
          {markers.map((m, i) => (
            <g key={m.device.id}>
              {m.device.status === 'online' && (
                <circle cx={m.x} cy={m.y} r={4} fill="var(--ok)" opacity={0.3}>
                  <animate attributeName="r" values="4;10;4" dur="2s"
                    begin={`${(i * 0.3) % 2}s`} repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.3;0;0.3" dur="2s"
                    begin={`${(i * 0.3) % 2}s`} repeatCount="indefinite" />
                </circle>
              )}
              <circle cx={m.x} cy={m.y} r={3.5}
                fill={m.device.status === 'online' ? 'var(--ok)'
                  : m.device.status === 'offline' ? 'var(--danger)' : 'var(--ink-faint)'}
                stroke="var(--bg)" strokeWidth={1} />
              <title>
                {m.device.name} ({m.device.status})
                {m.point.city ? ` — ${m.point.city}, ${m.point.country}` : ''}
              </title>
            </g>
          ))}
        </svg>

        {/* Below-map list of placed devices, clickable. Mirrors mock's
            "Device distribution" panel where the dots have textual labels.
            Hidden in compact mode — the dots themselves are the signal,
            and tooltips on hover give the device name. */}
        {!compact && markers.length > 0 && (
          <div style={{
            marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6,
            fontSize: 11,
          }}>
            {markers.map(m => (
              <Link key={m.device.id} to={`/devices/${m.device.id}`}
                style={{
                  textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
                  gap: 5, padding: '3px 8px', borderRadius: 3,
                  border: '1px solid var(--line)', background: 'var(--bg-subtle)',
                  color: 'var(--ink)',
                }}>
                <span className={`status ${m.device.status}`}>
                  <span className="d" style={{ width: 5, height: 5 }}/>
                </span>
                <span className="mono">{m.device.name}</span>
                {m.point.city && (
                  <span className="dim" style={{ fontSize: 10 }}>{m.point.city}</span>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// --- World outline (simplified continents as SVG paths) ---------------------
// These are deliberately lo-fi shapes. Goal: recognizable "this is the world",
// not cartographic accuracy. Coordinates are equirectangular (W=720, H=360).
function WorldOutline() {
  const fill = 'var(--line)'
  const opacity = 0.6
  return (
    <g fill={fill} opacity={opacity}>
      {/* North America */}
      <path d="M 90 60 L 200 60 L 220 90 L 230 130 L 200 175 L 180 180 L 150 165 L 120 180 L 100 160 L 85 130 L 80 100 Z" />
      {/* South America */}
      <path d="M 200 195 L 230 200 L 245 230 L 240 270 L 220 310 L 200 320 L 195 290 L 200 240 Z" />
      {/* Europe */}
      <path d="M 340 70 L 400 70 L 410 95 L 395 110 L 360 115 L 345 100 Z" />
      {/* Africa */}
      <path d="M 360 130 L 410 130 L 425 165 L 430 220 L 410 270 L 385 280 L 365 240 L 355 180 Z" />
      {/* Asia */}
      <path d="M 410 65 L 560 60 L 620 90 L 640 120 L 615 150 L 560 165 L 510 145 L 460 130 L 425 100 Z" />
      {/* India */}
      <path d="M 510 145 L 540 145 L 545 180 L 525 200 L 510 180 Z" />
      {/* SE Asia */}
      <path d="M 580 165 L 615 170 L 620 195 L 595 200 L 580 185 Z" />
      {/* Australia */}
      <path d="M 600 235 L 660 240 L 670 265 L 645 280 L 600 270 Z" />
      {/* Greenland */}
      <path d="M 290 40 L 330 40 L 335 70 L 305 80 L 290 60 Z" />
    </g>
  )
}
