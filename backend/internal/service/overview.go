package service

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// GetDeviceOverview fans out to several VyOS op-mode `show` commands and
// returns a single struct the UI can render in one round trip. Every field
// is best-effort: a parse failure on uptime doesn't kill memory, and so on.
// All four sub-fetches run concurrently because the device handles them
// independently and we want sub-second total latency.
func (s *Service) GetDeviceOverview(ctx context.Context, deviceID string) (*model.DeviceOverview, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	out := &model.DeviceOverview{}
	var wg sync.WaitGroup
	wg.Add(4)

	go func() {
		defer wg.Done()
		// `show system memory` returns lines like "Total: 7969\nFree: 939\nUsed: 7030"
		// (values in MB). We keep MB as-is on the wire so the UI can format it.
		if raw, err := client.Show(ctx, []string{"system", "memory"}); err == nil {
			out.RawMemory = strings.TrimSpace(raw)
			out.MemoryTotalMB, out.MemoryUsedMB, out.MemoryFreeMB = parseSystemMemory(raw)
		}
	}()

	go func() {
		defer wg.Done()
		// `show system uptime` returns text like:
		//   "uptime: 5 days, 2:34, load average: 0.12, 0.08, 0.05"
		// We extract uptime seconds and 1/5/15-min load averages.
		if raw, err := client.Show(ctx, []string{"system", "uptime"}); err == nil {
			out.RawUptime = strings.TrimSpace(raw)
			out.UptimeSeconds, out.Load1, out.Load5, out.Load15 = parseSystemUptime(raw)
		}
	}()

	go func() {
		defer wg.Done()
		// `show conntrack table ipv4` returns a table where each data row is
		// one active session. We count rows after the header. This is more
		// accurate than `show conntrack statistics`, which returns per-CPU
		// error counters and not a total session count.
		if raw, err := client.Show(ctx, []string{"conntrack", "table", "ipv4"}); err == nil {
			out.RawSessions = strings.TrimSpace(raw)
			out.SessionCount = parseSessionCount(raw)
		}
	}()

	go func() {
		defer wg.Done()
		// `show version` gives us hardware model / boot string in one shot.
		// We strip ANSI noise; VyOS sometimes inserts color codes.
		if raw, err := client.Show(ctx, []string{"version"}); err == nil {
			out.VersionDetails = strings.TrimSpace(stripANSI(raw))
		}
	}()

	wg.Wait()
	return out, nil
}

// parseSystemMemory turns the VyOS text response into MB integers.
// VyOS 1.5 format:
//
//	Total: 7.77 GB
//	Free:  7.04 GB
//	Used:  746.21 MB
//
// Older versions might report bare integers in MB. We handle both.
func parseSystemMemory(s string) (total, used, free int) {
	s = stripANSI(s)
	for _, line := range strings.Split(s, "\n") {
		l := strings.ToLower(strings.TrimSpace(line))
		if l == "" {
			continue
		}
		// Match "<float> <unit>?" — unit defaults to MB if absent.
		m := memNumRE.FindStringSubmatch(l)
		if len(m) != 3 {
			continue
		}
		val, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		unit := m[2]
		// Normalise to MB.
		var mb int
		switch unit {
		case "kb", "k":
			mb = int(val / 1024)
		case "gb", "g":
			mb = int(val * 1024)
		case "tb", "t":
			mb = int(val * 1024 * 1024)
		default: // "mb", "m", or empty
			mb = int(val)
		}
		switch {
		case strings.HasPrefix(l, "total"):
			total = mb
		case strings.HasPrefix(l, "used"):
			used = mb
		case strings.HasPrefix(l, "free"):
			free = mb
		}
	}
	// Sanity: if used is suspiciously larger than total, something's swapped.
	if total > 0 && used > total*2 {
		total, used, free = 0, 0, 0
	}
	return
}

// parseSystemUptime extracts seconds-since-boot and load averages.
// VyOS 1.5 format:
//
//	Uptime: 2d 2h 44m 35s
//	Load averages:
//	1  minute:   15.1%
//	5  minutes:  13.8%
//	15 minutes:  12.9%
//
// Note loads are reported as percentages, NOT classic Unix decimals. We keep
// them as percentages on the wire (the tile labels them as % anyway) so a
// load of 15.1% means "15.1% CPU utilization averaged over 1 minute".
func parseSystemUptime(s string) (uptime int, l1, l5, l15 float64) {
	for _, line := range strings.Split(s, "\n") {
		l := strings.TrimSpace(line)
		ll := strings.ToLower(l)

		// Uptime line: "Uptime: 2d 2h 44m 35s" — sum the d/h/m/s parts.
		if strings.HasPrefix(ll, "uptime:") {
			uptime = parseUptimeShortForm(l)
			continue
		}
		// Load lines: "1  minute:   15.1%", "5  minutes: ...", "15 minutes: ..."
		// Match the leading number to identify which window, then pull the
		// percentage value off the right side.
		if m := loadLineRE.FindStringSubmatch(ll); len(m) == 3 {
			window := m[1]
			val, _ := strconv.ParseFloat(m[2], 64)
			switch window {
			case "1":
				l1 = val
			case "5":
				l5 = val
			case "15":
				l15 = val
			}
		}
	}
	return
}

// parseUptimeShortForm handles VyOS 1.5's compact form: "2d 2h 44m 35s".
// Falls through to legacy "up 5 days, 2:34" form if the new pattern misses.
func parseUptimeShortForm(s string) int {
	var total int
	for _, m := range upShortRE.FindAllStringSubmatch(s, -1) {
		val, _ := strconv.Atoi(m[1])
		switch strings.ToLower(m[2]) {
		case "d":
			total += val * 86400
		case "h":
			total += val * 3600
		case "m":
			total += val * 60
		case "s":
			total += val
		}
	}
	if total == 0 {
		// Fallback to older format: "up 5 days, 2:34" or "up 12 minutes".
		return parseUptimeLegacy(s)
	}
	return total
}

func parseUptimeLegacy(s string) int {
	var total int
	if m := daysRE.FindStringSubmatch(s); len(m) == 2 {
		d, _ := strconv.Atoi(m[1])
		total += d * 86400
	}
	if m := hoursMinRE.FindStringSubmatch(s); len(m) == 3 {
		h, _ := strconv.Atoi(m[1])
		mi, _ := strconv.Atoi(m[2])
		total += h*3600 + mi*60
	} else if m := onlyMinRE.FindStringSubmatch(s); len(m) == 2 {
		mi, _ := strconv.Atoi(m[1])
		total += mi * 60
	}
	return total
}

// parseSessionCount counts data rows in `show conntrack table ipv4`. The
// format is a header row, a separator row of dashes, then one row per active
// connection. We count lines that look like data (starts with a long ID
// number) and return that as the session count.
func parseSessionCount(s string) int {
	var n int
	for _, line := range strings.Split(s, "\n") {
		l := strings.TrimSpace(line)
		if l == "" {
			continue
		}
		// Skip header ("Id Original src ...") and separator ("---- ----").
		// Data rows start with a numeric connection id.
		if !sessionRowRE.MatchString(l) {
			continue
		}
		n++
	}
	return n
}

var (
	loadLineRE  = regexp.MustCompile(`^\s*(\d+)\s+minutes?:\s*([\d.]+)\s*%`)
	upShortRE   = regexp.MustCompile(`(\d+)\s*([dhms])`)
	memNumRE    = regexp.MustCompile(`([\d.]+)\s*(kb|mb|gb|tb|k|m|g|t)?\b`)
	daysRE      = regexp.MustCompile(`(\d+)\s+days?`)
	hoursMinRE  = regexp.MustCompile(`(\d+):(\d+)`)
	onlyMinRE   = regexp.MustCompile(`(\d+)\s+min`)
	ansiRE      = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	sessionRowRE = regexp.MustCompile(`^\d{5,}\s`)
)

func stripANSI(s string) string { return ansiRE.ReplaceAllString(s, "") }
