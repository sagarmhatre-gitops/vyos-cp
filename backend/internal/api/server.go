// Package api is the HTTP surface of vyos-cp. Routes, auth, WebSocket.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/poller"
	"github.com/vyos-cp/vyos-cp/internal/service"
	"github.com/vyos-cp/vyos-cp/internal/store"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
)

type Server struct {
	svc      *service.Service
	poller   *poller.Poller
	jwtKey   []byte
	staticFS fs.FS
}

func NewServer(svc *service.Service, p *poller.Poller, jwtKey []byte, staticFS fs.FS) *Server {
	return &Server{svc: svc, poller: p, jwtKey: jwtKey, staticFS: staticFS}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: false,
	}))

	// Public
	r.Post("/api/v1/auth/login", s.login)
	r.Post("/api/v1/auth/bootstrap", s.bootstrap)

	// WebSocket (still validates the JWT via query param since browsers
	// can't set Authorization on a WS upgrade).
	r.Get("/api/v1/ws", s.wsHandler)

	// Protected
	r.Group(func(r chi.Router) {
		r.Use(s.authMW)

		r.Get("/api/v1/me", s.me)

		r.Get("/api/v1/devices", s.listDevices)
		r.Post("/api/v1/devices", s.addDevice)
		r.Get("/api/v1/devices/{id}", s.getDevice)
		r.Delete("/api/v1/devices/{id}", s.deleteDevice)

		r.Get("/api/v1/devices/{id}/firewall/{family}/rulesets", s.listRuleSets)
		r.Get("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}", s.getRuleSet)
		r.Put("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}/rules/{n}", s.upsertRule)
		r.Post("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}/rules", s.upsertRule)
		r.Delete("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}/rules/{n}", s.deleteRule)

		r.Post("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}/simulate", s.simulatePacket)
		r.Get("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}/shadow", s.shadowAnalysis)
		r.Post("/api/v1/devices/{id}/firewall/{family}/rulesets/{name}/translate-preview", s.translatePreview)

		r.Post("/api/v1/devices/{id}/firewall/groups", s.upsertGroup)

		r.Get("/api/v1/audit", s.listAudit)

		r.Get("/api/v1/templates", s.listTemplates)
		r.Post("/api/v1/templates", s.saveTemplate)
		r.Post("/api/v1/templates/{name}/push", s.pushTemplate)
		r.Delete("/api/v1/templates/{name}", s.deleteTemplate)

		s.RegisterExtras(r)
	})

	// Static SPA — serve the React build.
	if s.staticFS != nil {
		r.Handle("/*", s.spaHandler())
	}

	return r
}

// --- Auth -------------------------------------------------------------------

type ctxKey string

const (
	ctxUserID   ctxKey = "uid"
	ctxUserName ctxKey = "uname"
)

func (s *Server) authMW(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := extractBearer(r)
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		claims, err := s.parseJWT(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), ctxUserID, claims["sub"])
		ctx = context.WithValue(ctx, ctxUserName, claims["name"])
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	// For WebSocket, accept ?token= since browsers can't set headers.
	return r.URL.Query().Get("token")
}

func (s *Server) parseJWT(t string) (jwt.MapClaims, error) {
	tok, err := jwt.Parse(t, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return s.jwtKey, nil
	})
	if err != nil || !tok.Valid {
		return nil, errors.New("invalid")
	}
	c, _ := tok.Claims.(jwt.MapClaims)
	return c, nil
}

func (s *Server) issueJWT(u *model.User) (string, error) {
	claims := jwt.MapClaims{
		"sub":   u.ID,
		"name":  u.DisplayName,
		"email": u.Email,
		"roles": u.Roles,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(12 * time.Hour).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtKey)
}

func userFromCtx(ctx context.Context) (id, name string) {
	if v, ok := ctx.Value(ctxUserID).(string); ok {
		id = v
	}
	if v, ok := ctx.Value(ctxUserName).(string); ok {
		name = v
	}
	return
}

// --- Auth handlers ----------------------------------------------------------

// bootstrap creates the first admin user when no users exist. Refuses once
// any user is present. Useful for fresh installs; in prod we'd use seed SQL.
func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	n, err := s.svc.Store().CountUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if n > 0 {
		writeErr(w, http.StatusConflict, "users already exist")
		return
	}
	var body struct {
		Email       string `json:"email"`
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Email == "" || body.Password == "" {
		writeErr(w, http.StatusBadRequest, "email and password required")
		return
	}
	pwHash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	u, err := s.svc.Store().CreateUser(r.Context(), model.User{
		Email: body.Email, DisplayName: body.DisplayName,
		Roles: []model.Role{model.RoleAdmin},
	}, string(pwHash))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	tok, _ := s.issueJWT(u)
	writeJSON(w, http.StatusOK, map[string]any{"token": tok, "user": u})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct{ Email, Password string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	u, pw, err := s.svc.Store().GetUserByEmail(r.Context(), body.Email)
	if err != nil || u.Disabled {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(pw), []byte(body.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	tok, err := s.issueJWT(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": tok, "user": u})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	id, name := userFromCtx(r.Context())
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "name": name})
}

// --- Devices ---------------------------------------------------------------

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	devs, err := s.svc.Store().ListDevices(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Attach latest throughput so the Devices table can render Mbps inline
	// without a separate round-trip. Sourced from the Postgres-backed minute
	// buckets (last 5 min window in the query).
	latest, _ := s.svc.Store().LatestThroughputByDevice(r.Context())
	type deviceWithThru struct {
		*model.Device
		Throughput *store.ThroughputRow `json:"throughput,omitempty"`
	}
	out := make([]deviceWithThru, 0, len(devs))
	for i := range devs {
		d := devs[i]
		row := deviceWithThru{Device: &d}
		if t, ok := latest[d.ID]; ok {
			row.Throughput = &t
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getDevice(w http.ResponseWriter, r *http.Request) {
	d, err := s.svc.Store().GetDevice(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) addDevice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name               string   `json:"name"`
		Address            string   `json:"address"`
		APIKey             string   `json:"api_key"`
		Tags               []string `json:"tags"`
		InsecureSkipVerify bool     `json:"insecure_skip_verify"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Name == "" || body.Address == "" || body.APIKey == "" {
		writeErr(w, http.StatusBadRequest, "name, address, api_key required")
		return
	}
	uid, uname := userFromCtx(r.Context())
	d, err := s.svc.AddDevice(r.Context(), model.Device{
		Name: body.Name, Address: body.Address,
		Tags: body.Tags, InsecureSkipVerify: body.InsecureSkipVerify,
	}, body.APIKey, uid, uname)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

func (s *Server) deleteDevice(w http.ResponseWriter, r *http.Request) {
	if err := s.svc.Store().DeleteDevice(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Rule-sets --------------------------------------------------------------

func (s *Server) listRuleSets(w http.ResponseWriter, r *http.Request) {
	rs, err := s.svc.ListRuleSets(r.Context(),
		chi.URLParam(r, "id"), chi.URLParam(r, "family"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rs)
}

func (s *Server) getRuleSet(w http.ResponseWriter, r *http.Request) {
	rs, err := s.svc.GetRuleSet(r.Context(),
		chi.URLParam(r, "id"), chi.URLParam(r, "family"), chi.URLParam(r, "name"))
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rs)
}

func (s *Server) upsertRule(w http.ResponseWriter, r *http.Request) {
	var rule model.Rule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if n := chi.URLParam(r, "n"); n != "" {
		num, err := strconv.Atoi(n)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad rule number")
			return
		}
		rule.Number = num
	}
	uid, uname := userFromCtx(r.Context())
	err := s.svc.UpsertRule(r.Context(), uid, uname,
		chi.URLParam(r, "id"), chi.URLParam(r, "family"),
		chi.URLParam(r, "name"), rule)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rule)
}

func (s *Server) deleteRule(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.Atoi(chi.URLParam(r, "n"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad rule number")
		return
	}
	uid, uname := userFromCtx(r.Context())
	err = s.svc.DeleteRule(r.Context(), uid, uname,
		chi.URLParam(r, "id"), chi.URLParam(r, "family"),
		chi.URLParam(r, "name"), n)
	if err != nil {
		writeVyosErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Groups ----------------------------------------------------------------

func (s *Server) upsertGroup(w http.ResponseWriter, r *http.Request) {
	var g model.Group
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	if err := s.svc.UpsertGroup(r.Context(), uid, uname, chi.URLParam(r, "id"), g); err != nil {
		writeVyosErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// --- Audit & templates ------------------------------------------------------

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.svc.Store().ListAudit(r.Context(), deviceID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	ts, err := s.svc.Store().ListTemplates(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ts)
}

func (s *Server) saveTemplate(w http.ResponseWriter, r *http.Request) {
	var rs model.RuleSet
	if err := json.NewDecoder(r.Body).Decode(&rs); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, _ := userFromCtx(r.Context())
	if err := s.svc.Store().SaveTemplate(r.Context(), rs.Name, rs, uid); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rs)
}

func (s *Server) pushTemplate(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	rs, err := s.svc.Store().GetTemplate(r.Context(), name)
	if err != nil {
		writeErr(w, http.StatusNotFound, "template not found")
		return
	}
	var body struct {
		DeviceIDs []string `json:"device_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	uid, uname := userFromCtx(r.Context())
	results := s.svc.PushRuleSet(r.Context(), uid, uname, body.DeviceIDs, *rs)
	out := make(map[string]map[string]string, len(results))
	for id, err := range results {
		entry := map[string]string{"status": "ok"}
		if err != nil {
			entry["status"] = "error"
			entry["error"] = err.Error()
		}
		out[id] = entry
	}
	writeJSON(w, http.StatusOK, out)
}

// --- WebSocket --------------------------------------------------------------

func (s *Server) wsHandler(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if _, err := s.parseJWT(token); err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid token")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "closing")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	deviceFilter := r.URL.Query().Get("device_id")
	ch := s.poller.Subscribe()
	defer s.poller.Unsubscribe(ch)

	// Keep-alive ping.
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = c.Ping(ctx)
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case e := <-ch:
			if deviceFilter != "" && e.DeviceID != deviceFilter {
				continue
			}
			buf, _ := json.Marshal(e)
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.Write(wctx, websocket.MessageText, buf)
			wcancel()
			if err != nil {
				log.Printf("ws write: %v", err)
				return
			}
		}
	}
}

// --- Static SPA handler -----------------------------------------------------

func (s *Server) spaHandler() http.Handler {
	fileServer := http.FileServer(http.FS(s.staticFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve file if exists; otherwise fall back to index.html (SPA routing).
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(s.staticFS, path); err != nil {
			// Not found → index.html.
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

// --- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// writeVyosErr maps known VyOS error types to meaningful HTTP status.
func writeVyosErr(w http.ResponseWriter, err error) {
	if vyos.IsAuthError(err) {
		writeErr(w, http.StatusBadGateway, "device rejected api key")
		return
	}
	var ve *vyos.Error
	if errors.As(err, &ve) {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":   ve.Message,
			"source":  "vyos",
			"endpoint": ve.Endpoint,
		})
		return
	}
	writeErr(w, http.StatusInternalServerError, fmt.Sprintf("%v", err))
}

func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	if !s.requireRole(w, r, "template.save") {
		return
	}
	if err := s.svc.Store().DeleteTemplate(r.Context(), chi.URLParam(r, "name")); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
