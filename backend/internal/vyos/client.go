// Package vyos is a production-grade client for the VyOS HTTP API, verified
// against both 1.4 (sagitta) and 1.5 (circinus).
//
// Protocol notes from the VyOS docs that shape this code:
//   - All endpoints except GET /info are POST with multipart/form-data.
//   - The `data` field carries JSON (a single object, or an array on /configure).
//   - The `key` field carries the API key in form-data (never a header).
//   - /configure with an array of ops is atomic — one session, one commit.
//   - commit-confirm: add `confirm_time` (minutes) to auto-revert unless
//     /confirm is called in time. The single most important safety feature.
//   - Every response has {success: bool, data: any, error: string|null}.
package vyos

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"strings"
	"time"
)

// Op is a VyOS configuration operation.
type Op string

const (
	OpSet        Op = "set"
	OpDelete     Op = "delete"
	OpComment    Op = "comment"
	OpShowConfig Op = "showConfig"
	OpExists     Op = "exists"
	OpReturnVal  Op = "returnValue"
	OpReturnVals Op = "returnValues"
	OpShow       Op = "show"
)

// ConfigureOp is one op inside a /configure request.
type ConfigureOp struct {
	Op    Op       `json:"op"`
	Path  []string `json:"path"`
	Value string   `json:"value,omitempty"`
}

// Response is the common VyOS envelope.
type Response struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   *string         `json:"error"`
}

// Info is returned by GET /info. Used for health checks and version-based
// feature gating.
type Info struct {
	Version  string `json:"version"`
	Hostname string `json:"hostname"`
	Banner   string `json:"banner"`
}

// Client talks to a single VyOS device.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// Config configures a new client.
type Config struct {
	BaseURL            string        // https://vyos.example:443
	APIKey             string
	InsecureSkipVerify bool          // accept self-signed certs (lab)
	Timeout            time.Duration // per-request; default 30s
}

// New builds a client. An http.Client with sensible defaults is constructed;
// callers that need to swap transports can call NewWithHTTP.
func New(cfg Config) *Client {
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	tr := &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: cfg.InsecureSkipVerify},
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}
	return &Client{
		baseURL: strings.TrimRight(cfg.BaseURL, "/"),
		apiKey:  cfg.APIKey,
		http:    &http.Client{Timeout: cfg.Timeout, Transport: tr},
	}
}

// Configure sends an atomic batch of set/delete/comment ops. VyOS commits
// the whole batch or none of it. If confirmTime > 0, the commit is a
// commit-confirm — it reverts unless Confirm() is called within that many
// minutes.
func (c *Client) Configure(ctx context.Context, ops []ConfigureOp, confirmTime int) error {
	if len(ops) == 0 {
		return errors.New("vyos.Configure: no ops")
	}
	payload, err := json.Marshal(ops)
	if err != nil {
		return fmt.Errorf("marshal ops: %w", err)
	}
	extra := map[string]string{}
	if confirmTime > 0 {
		// VyOS accepts confirm_time as a top-level form field on /configure.
		extra["confirm_time"] = fmt.Sprintf("%d", confirmTime)
	}
	_, err = c.post(ctx, "/configure", payload, extra)
	return err
}

// Confirm finalizes a commit-confirm commit. On VyOS 1.4+ the confirm
// operation is done via the /configure endpoint with a single "confirm" op,
// NOT via "show commit-confirm". Earlier builds of this client used the
// latter; newer VyOS builds return "Invalid command: show [commit-confirm]".
func (c *Client) Confirm(ctx context.Context) error {
	payload, _ := json.Marshal([]map[string]any{{"op": "confirm"}})
	_, err := c.post(ctx, "/configure", payload, nil)
	return err
}

// Retrieve fetches config at a path; pass empty path for the whole tree.
func (c *Client) Retrieve(ctx context.Context, op Op, path []string) (json.RawMessage, error) {
	req := map[string]any{"op": op, "path": path}
	payload, _ := json.Marshal(req)
	return c.post(ctx, "/retrieve", payload, nil)
}

// Exists returns whether a config path exists (cheap, used for health checks).
func (c *Client) Exists(ctx context.Context, path []string) (bool, error) {
	raw, err := c.Retrieve(ctx, OpExists, path)
	if err != nil {
		return false, err
	}
	var b bool
	_ = json.Unmarshal(raw, &b)
	return b, nil
}

// Show runs a `show` op-mode command and returns the raw text output.
// Examples:
//
//	Show(ctx, ["system", "memory"])    → "show system memory"
//	Show(ctx, ["interfaces"])          → "show interfaces"
//	Show(ctx, ["configuration", "commands"])  → "show configuration commands"
//
// VyOS's /show endpoint only accepts op="show". Other op-mode verbs
// (ping, traceroute, monitor traffic) are NOT exposed via the HTTP API
// and cannot be invoked through this method — see VyOS T1868 + the v23/
// v27 quick-actions debugging history. Use SSH for those.
func (c *Client) Show(ctx context.Context, path []string) (string, error) {
	req := map[string]any{"op": "show", "path": path}
	payload, _ := json.Marshal(req)
	raw, err := c.post(ctx, "/show", payload, nil)
	if err != nil {
		return "", err
	}
	var s string
	_ = json.Unmarshal(raw, &s)
	return s, nil
}

// Save persists the running config to startup. Call this after every
// confirmed commit so the device survives a reboot with the new rules.
func (c *Client) Save(ctx context.Context) error {
	req := map[string]any{"op": "save"}
	payload, _ := json.Marshal(req)
	_, err := c.post(ctx, "/config-file", payload, nil)
	return err
}

// Info retrieves hostname via /retrieve and version via `show version`
// op-mode. Portable across VyOS 1.4 / 1.5 builds.
func (c *Client) Info(ctx context.Context) (*Info, error) {
	raw, err := c.Retrieve(ctx, OpShowConfig, []string{"system", "host-name"})
	if err != nil {
		return nil, err
	}
	var hostname string
	_ = json.Unmarshal(raw, &hostname)

	// Version from `show version` — parse the first "Version:" line.
	version := ""
	if out, err := c.Show(ctx, []string{"version"}); err == nil {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Version:") {
				version = strings.TrimSpace(strings.TrimPrefix(line, "Version:"))
				break
			}
		}
	}
	return &Info{Hostname: hostname, Version: version}, nil
}

// Ping is a cheap health check — verifies the device is reachable AND the
// API key is valid. Used by the poller every tick.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.Exists(ctx, []string{"system", "host-name"})
	return err
}

// Reboot triggers a device reboot via the /reboot endpoint. The device
// becomes unreachable for 1-3 minutes; callers should warn the user. The
// VyOS API returns immediately after queueing the reboot; we don't wait
// for it to actually shut down.
func (c *Client) Reboot(ctx context.Context) error {
	// /reboot accepts an empty data payload. We send `{}` so the multipart
	// form has a non-empty `data` field — VyOS rejects the request otherwise.
	_, err := c.post(ctx, "/reboot", []byte("{}"), nil)
	return err
}

// post is the common transport.
func (c *Client) post(ctx context.Context, endpoint string, data []byte, extra map[string]string) (json.RawMessage, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("data", string(data)); err != nil {
		return nil, err
	}
	if err := mw.WriteField("key", c.apiKey); err != nil {
		return nil, err
	}
	for k, v := range extra {
		if err := mw.WriteField(k, v); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+endpoint, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Endpoint: endpoint, Cause: err}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Device down / non-JSON: surface a useful error, not a parse failure.
	if resp.StatusCode >= 500 || !json.Valid(raw) {
		return nil, &Error{
			Endpoint: endpoint,
			Status:   resp.StatusCode,
			Message:  truncate(string(raw), 256),
		}
	}

	var r Response
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, &Error{Endpoint: endpoint, Status: resp.StatusCode, Message: string(raw)}
	}
	if !r.Success {
		return nil, &Error{
			Endpoint: endpoint,
			Status:   resp.StatusCode,
			Message:  deref(r.Error),
		}
	}
	return r.Data, nil
}

// Error wraps a VyOS API failure. Service layer maps these to HTTP status.
type Error struct {
	Endpoint string
	Status   int
	Message  string
	Cause    error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("vyos %s: %v", e.Endpoint, e.Cause)
	}
	return fmt.Sprintf("vyos %s [%d]: %s", e.Endpoint, e.Status, e.Message)
}

func (e *Error) Unwrap() error { return e.Cause }

// IsAuthError reports whether the error is due to a rejected API key.
// VyOS returns 401 without a JSON body when the key is wrong.
func IsAuthError(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	return e.Status == 401 || strings.Contains(strings.ToLower(e.Message), "unauthorized")
}

func deref(s *string) string {
	if s == nil {
		return "unknown error"
	}
	return *s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
