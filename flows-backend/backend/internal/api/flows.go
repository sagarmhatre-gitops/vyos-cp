package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

// deviceFlows serves the latest conntrack flow snapshot:
//   GET /api/v1/devices/{id}/flows?limit=500
func (s *Server) deviceFlows(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limit := 500
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	flows, err := s.poller.FlowsLatest(r.Context(), id, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, flows)
}
