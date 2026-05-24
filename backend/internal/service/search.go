package service

import (
	"context"
	"sort"
	"strings"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// SearchHit is one entry in a global-search result. The kind drives the UI
// icon and click-target route. `score` orders results across kinds so an
// exact match outranks a fuzzy one regardless of category.
type SearchHit struct {
	Kind     string `json:"kind"`     // "device" | "user" | future: "group", "rule_set", "zone"
	ID       string `json:"id"`       // primary key — for routing
	Title    string `json:"title"`    // headline label shown in the dropdown
	Subtitle string `json:"subtitle"` // grey secondary line
	Score    int    `json:"-"`        // not exposed; used only for sorting
}

// Search runs a single fan-out query across the searchable record types
// the cp manages. Token-based, case-insensitive, prefix-friendly.
//
// Scoring (lower = stronger):
//
//	1   Title prefix-match the query exactly
//	5   Title contains query as substring
//	8   Subtitle contains query as substring
//	20  Any token in record contains query (catch-all)
//
// We cap to 20 hits since the dropdown is finite real estate; if a query
// is too broad the user can refine. Future kinds (groups, rule-sets, zones)
// plug in here without changing the API surface.
func (s *Service) Search(ctx context.Context, query string) ([]SearchHit, error) {
	q := strings.TrimSpace(strings.ToLower(query))
	if q == "" {
		return nil, nil
	}

	var hits []SearchHit

	// --- Devices --------------------------------------------------------
	if devs, err := s.store.ListDevices(ctx); err == nil {
		for _, d := range devs {
			if h, ok := scoreDevice(d, q); ok {
				hits = append(hits, h)
			}
		}
	}

	// --- Users ----------------------------------------------------------
	if users, err := s.store.ListUsers(ctx); err == nil {
		for _, u := range users {
			if h, ok := scoreUser(u, q); ok {
				hits = append(hits, h)
			}
		}
	}

	// Sort by score, then by title for stability across requests.
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score < hits[j].Score
		}
		return hits[i].Title < hits[j].Title
	})

	if len(hits) > 20 {
		hits = hits[:20]
	}
	return hits, nil
}

func scoreDevice(d model.Device, q string) (SearchHit, bool) {
	name := strings.ToLower(d.Name)
	addr := strings.ToLower(d.Address)
	tags := strings.ToLower(strings.Join(d.Tags, " "))

	score := 0
	switch {
	case strings.HasPrefix(name, q):
		score = 1
	case strings.Contains(name, q):
		score = 5
	case strings.Contains(addr, q):
		score = 8
	case strings.Contains(tags, q):
		score = 12
	default:
		// Last resort: split address by dots and check octets — lets users
		// search for a partial IP like "10.10" or just the final octet.
		hit := false
		for _, tok := range strings.Split(addr, ".") {
			if tok != "" && strings.Contains(tok, q) {
				hit = true
				break
			}
		}
		if !hit {
			return SearchHit{}, false
		}
		score = 20
	}
	return SearchHit{
		Kind:     "device",
		ID:       d.ID,
		Title:    d.Name,
		Subtitle: d.Address,
		Score:    score,
	}, true
}

func scoreUser(u model.User, q string) (SearchHit, bool) {
	name := strings.ToLower(u.DisplayName)
	email := strings.ToLower(u.Email)

	score := 0
	switch {
	case strings.HasPrefix(name, q):
		score = 1
	case strings.HasPrefix(email, q):
		score = 2
	case strings.Contains(name, q):
		score = 5
	case strings.Contains(email, q):
		score = 6
	default:
		return SearchHit{}, false
	}
	display := u.DisplayName
	if display == "" {
		display = u.Email
	}
	return SearchHit{
		Kind:     "user",
		ID:       u.ID,
		Title:    display,
		Subtitle: u.Email,
		Score:    score,
	}, true
}
