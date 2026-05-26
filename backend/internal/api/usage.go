package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

// deviceUsage serves accumulated usage rollups:
//   GET /api/v1/devices/{id}/usage?period=hour|day|month&hours=24
// Returns rollup rows (one per scope per period), oldest-first.
func (s *Server) deviceUsage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	period := r.URL.Query().Get("period")
	if period == "" {
		period = "hour"
	}
	if period != "hour" && period != "day" && period != "month" {
		http.Error(w, "period must be hour|day|month", http.StatusBadRequest)
		return
	}
	hours := 24
	if h := r.URL.Query().Get("hours"); h != "" {
		if n, err := strconv.Atoi(h); err == nil && n > 0 {
			hours = n
		}
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	rows, err := s.poller.UsageRange(r.Context(), id, period, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}
