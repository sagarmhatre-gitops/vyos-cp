package service

import (
	"context"

	"github.com/vyos-cp/vyos-cp/internal/model"
)

// QuickActions — operator-essential operations exposed in the UI as one-click
// buttons. All flow through the standard audit log so we have a record.
//
// HISTORY: v23 added Ping + Traceroute here; v27 attempted a fix routing
// through op="ping"/op="traceroute" on the /show endpoint. Both failed:
// VyOS's HTTP API has a strict whitelist on the `op` field per endpoint
// (/show only accepts op="show", confirmed via VyOS T1868 + 1.4/1.5 docs),
// and ping/traceroute have no dedicated API endpoint. They were removed in
// v28; will return as part of an SSH-based code path in a future phase.


// RebootDevice fires a reboot via /reboot. Caller MUST gate this with a
// confirmation step in the UI — there's no "are you sure" on the API
// itself. The audit row records the kickoff; the device may not be in any
// state to record the completion.
func (s *Service) RebootDevice(ctx context.Context, userID, userName, deviceID string) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	err = client.Reboot(ctx)
	_ = s.store.RecordAudit(ctx, model.AuditEntry{
		UserID: userID, UserName: userName, DeviceID: deviceID,
		Action:    "device.reboot",
		Success:   err == nil,
		ErrorMsg:  errString(err),
	})
	// Invalidate the cached client; on reconnect the keepalive may otherwise
	// reuse a connection to a now-dead session.
	s.clients.Invalidate(deviceID)
	return err
}

// BackupConfig returns the running config as VyOS-style "set" commands. This
// is the round-trip-safe form: the operator can paste it into a fresh
// device's `configure` mode and recreate the state. We use the op-mode
// `show configuration commands` which produces this format directly.
func (s *Service) BackupConfig(ctx context.Context, userID, userName, deviceID string) (string, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return "", err
	}
	raw, err := client.Show(ctx, []string{"configuration", "commands"})
	_ = s.store.RecordAudit(ctx, model.AuditEntry{
		UserID: userID, UserName: userName, DeviceID: deviceID,
		Action:    "config.backup",
		Success:   err == nil,
		ErrorMsg:  errString(err),
	})
	return raw, err
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
