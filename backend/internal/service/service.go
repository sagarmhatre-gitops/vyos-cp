// Package service contains business logic between HTTP handlers and the
// VyOS client pool. Every device write is audit-logged.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/store"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// CommitConfirmMinutes is how long a commit-confirm waits before reverting.
// Set via env VYOS_CP_COMMIT_CONFIRM_MINUTES (0 = no commit-confirm).
var CommitConfirmMinutes = 1

type Service struct {
	store *store.Store
	// clients is the concrete pool — kept for GetClient() (used by the
	// poller, which needs the real *vyos.Client) and for Invalidate.
	clients *ClientPool
	// cp is the interface-typed view of the same pool, used by every
	// service method that we want to be unit-testable without a real
	// VyOS device. See interfaces.go for the rationale.
	cp clientPool
	// auditFn and getDeviceFn are seams for testing — they default to
	// the real audit / device-lookup paths, but tests can override them
	// to avoid needing a real *store.Store. Production code should not
	// set these directly; they are populated by New().
	auditFn     auditFunc
	getDeviceFn getDeviceFunc
}

// auditFunc and getDeviceFunc abstract just the two store interactions
// that the configure-flow needs. Other methods still talk to s.store
// directly (CreateDevice, ListAudit, etc.) because they're not on the
// per-write hot path that tests need to fake out.
type auditFunc func(ctx context.Context, userID, userName, deviceID, deviceName, action string,
	ops []model.ConfigureOp, success bool, errMsg string) error

type getDeviceFunc func(ctx context.Context, deviceID string) (*model.Device, error)

func New(s *store.Store) *Service {
	pool := NewClientPool(s)
	svc := &Service{
		store:   s,
		clients: pool,
		cp:      &clientPoolAdapter{pool: pool},
	}
	// Default seams point at the real store. Tests substitute their own.
	svc.auditFn = svc.audit
	svc.getDeviceFn = s.GetDevice
	return svc
}

func (s *Service) Store() *store.Store { return s.store }

// GetClient returns the cached VyOS client for a device (shared with poller).
func (s *Service) GetClient(ctx context.Context, deviceID string) (*vyos.Client, error) {
	return s.clients.Get(ctx, deviceID)
}

// --- Device management -----------------------------------------------------

// AddDevice registers a device and verifies the API key works before persisting.
func (s *Service) AddDevice(ctx context.Context, d model.Device, apiKey, userID, userName string) (*model.Device, error) {
	// Pre-flight: verify the key works. Better to fail at add-time than
	// later when the user tries to push rules.
	client := vyos.New(vyos.Config{
		BaseURL:            d.Address,
		APIKey:             apiKey,
		InsecureSkipVerify: d.InsecureSkipVerify,
		Timeout:            15 * time.Second,
	})
	ctx2, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	info, err := client.Info(ctx2)
	if err != nil {
		return nil, fmt.Errorf("verify device: %w", err)
	}
	d.Version = info.Version
	d.Hostname = info.Hostname
	d.Status = "online"

	saved, err := s.store.CreateDevice(ctx, d, apiKey)
	if err != nil {
		return nil, err
	}
	_ = s.store.UpdateDeviceStatus(ctx, saved.ID, "online", info.Version, info.Hostname, "")
	saved.Version = info.Version
	saved.Hostname = info.Hostname

	_ = s.audit(ctx, userID, userName, saved.ID, saved.Name, "device.add", nil, true, "")
	return saved, nil
}

// --- Rule-sets -------------------------------------------------------------

func (s *Service) GetRuleSet(ctx context.Context, deviceID, family, name string) (*model.RuleSet, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"firewall", family, "name", name})
	if err != nil {
		return nil, err
	}
	return translator.DecodeRuleSet(family, name, raw)
}

func (s *Service) ListRuleSets(ctx context.Context, deviceID, family string) ([]model.RuleSet, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	// Fetch the parent; some VyOS builds return the response wrapped in an
	// extra key matching the last path segment.
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"firewall", family})
	if err != nil {
		return nil, err
	}
	// raw is shaped like: {"name": {"WAN-IN": {...}, "LAN-IN": {...}}}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(raw, &outer); err != nil {
		return nil, err
	}
	nameBlock, ok := outer["name"]
	if !ok || len(nameBlock) == 0 || string(nameBlock) == "null" {
		return nil, nil
	}
	return translator.DecodeRuleSetList(family, nameBlock)
}

// UpsertRule atomically replaces one rule (delete + set in one /configure).
func (s *Service) UpsertRule(ctx context.Context, userID, userName, deviceID, family, ruleset string, rule model.Rule) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	newOps, err := translator.RuleOps(family, ruleset, rule)
	if err != nil {
		return err
	}
	ops := append(translator.DeleteRuleOps(family, ruleset, rule.Number), newOps...)

	dev, _ := s.store.GetDevice(ctx, deviceID)
	devName := ""
	if dev != nil {
		devName = dev.Name
	}
	err = client.Configure(ctx, ops, CommitConfirmMinutes)
	if err == nil && CommitConfirmMinutes > 0 {
		// Best-effort confirm. If this fails, the commit reverts — which is
		// the safe outcome.
		_ = client.Confirm(ctx)
		_ = client.Save(ctx)
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	_ = s.audit(ctx, userID, userName, deviceID, devName, "rule.upsert", toModelOps(ops), err == nil, errMsg)
	return err
}

func (s *Service) DeleteRule(ctx context.Context, userID, userName, deviceID, family, ruleset string, number int) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := translator.DeleteRuleOps(family, ruleset, number)
	dev, _ := s.store.GetDevice(ctx, deviceID)
	devName := ""
	if dev != nil {
		devName = dev.Name
	}
	err = client.Configure(ctx, ops, CommitConfirmMinutes)
	if err == nil && CommitConfirmMinutes > 0 {
		_ = client.Confirm(ctx)
		_ = client.Save(ctx)
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	_ = s.audit(ctx, userID, userName, deviceID, devName, "rule.delete", toModelOps(ops), err == nil, errMsg)
	return err
}

// PushRuleSet applies a full rule-set to N devices in parallel.
func (s *Service) PushRuleSet(ctx context.Context, userID, userName string, deviceIDs []string, rs model.RuleSet) map[string]error {
	var wg sync.WaitGroup
	var mu sync.Mutex
	results := make(map[string]error, len(deviceIDs))
	for _, id := range deviceIDs {
		wg.Add(1)
		go func(deviceID string) {
			defer wg.Done()
			err := s.pushRuleSetOne(ctx, userID, userName, deviceID, rs)
			mu.Lock()
			results[deviceID] = err
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return results
}

func (s *Service) pushRuleSetOne(ctx context.Context, userID, userName, deviceID string, rs model.RuleSet) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops := []vyos.ConfigureOp{{
		Op: vyos.OpDelete, Path: []string{"firewall", rs.Family, "name", rs.Name},
	}}
	rsOps, err := translator.RuleSetOps(rs)
	if err != nil {
		return err
	}
	ops = append(ops, rsOps...)
	for _, r := range rs.Rules {
		rOps, err := translator.RuleOps(rs.Family, rs.Name, r)
		if err != nil {
			return fmt.Errorf("rule %d: %w", r.Number, err)
		}
		ops = append(ops, rOps...)
	}
	dev, _ := s.store.GetDevice(ctx, deviceID)
	devName := ""
	if dev != nil {
		devName = dev.Name
	}
	err = client.Configure(ctx, ops, CommitConfirmMinutes)
	if err == nil && CommitConfirmMinutes > 0 {
		_ = client.Confirm(ctx)
		_ = client.Save(ctx)
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	_ = s.audit(ctx, userID, userName, deviceID, devName, "ruleset.push", toModelOps(ops), err == nil, errMsg)
	return err
}

// --- Groups ----------------------------------------------------------------

func (s *Service) UpsertGroup(ctx context.Context, userID, userName, deviceID string, g model.Group) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	newOps, err := translator.GroupOps(g)
	if err != nil {
		return err
	}
	ops := append(translator.DeleteGroupOps(g), newOps...)
	dev, _ := s.store.GetDevice(ctx, deviceID)
	devName := ""
	if dev != nil {
		devName = dev.Name
	}
	err = client.Configure(ctx, ops, CommitConfirmMinutes)
	if err == nil && CommitConfirmMinutes > 0 {
		_ = client.Confirm(ctx)
		_ = client.Save(ctx)
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	_ = s.audit(ctx, userID, userName, deviceID, devName, "group.upsert", toModelOps(ops), err == nil, errMsg)
	return err
}

// --- audit helper ----------------------------------------------------------

func (s *Service) audit(ctx context.Context, userID, userName, deviceID, device, action string, ops []model.ConfigureOp, success bool, errMsg string) error {
	return s.store.RecordAudit(ctx, model.AuditEntry{
		Timestamp: time.Now(),
		UserID:    userID,
		UserName:  userName,
		DeviceID:  deviceID,
		Device:    device,
		Action:    action,
		Ops:       ops,
		Success:   success,
		ErrorMsg:  errMsg,
	})
}

func toModelOps(ops []vyos.ConfigureOp) []model.ConfigureOp {
	out := make([]model.ConfigureOp, len(ops))
	for i, o := range ops {
		out[i] = model.ConfigureOp{Op: string(o.Op), Path: o.Path, Value: o.Value}
	}
	return out
}

// Placate unused-import checker if json isn't used elsewhere.
