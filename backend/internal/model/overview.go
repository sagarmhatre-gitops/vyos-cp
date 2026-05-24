package model

// DeviceOverview is the snapshot returned by /api/v1/devices/{id}/overview.
// It collects situational-awareness data the operator wants in one glance:
// load, memory, sessions, uptime. Each field is best-effort — a fetch may
// have failed silently, in which case the field will be zero.
type DeviceOverview struct {
	// Resource pressure.
	MemoryTotalMB int     `json:"memory_total_mb,omitempty"`
	MemoryUsedMB  int     `json:"memory_used_mb,omitempty"`
	MemoryFreeMB  int     `json:"memory_free_mb,omitempty"`
	Load1         float64 `json:"load_1,omitempty"`
	Load5         float64 `json:"load_5,omitempty"`
	Load15        float64 `json:"load_15,omitempty"`

	// Activity.
	SessionCount  int `json:"session_count,omitempty"`
	UptimeSeconds int `json:"uptime_seconds,omitempty"`

	// Identity / banner.
	VersionDetails string `json:"version_details,omitempty"`

	// Raw text fallbacks — exposed so the UI can show literal VyOS output
	// when parsing failed, and so we can debug parser misses without SSH.
	RawMemory   string `json:"raw_memory,omitempty"`
	RawUptime   string `json:"raw_uptime,omitempty"`
	RawSessions string `json:"raw_sessions,omitempty"`
}
