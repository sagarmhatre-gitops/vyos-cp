package service

import (
	"context"

	"github.com/vyos-cp/vyos-cp/internal/model"
	"github.com/vyos-cp/vyos-cp/internal/vyos"
	"github.com/vyos-cp/vyos-cp/internal/vyos/translator"
)

// ListInterfaces reads all interfaces from the device.
func (s *Service) ListInterfaces(ctx context.Context, deviceID string) ([]model.Interface, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"interfaces"})
	if err != nil {
		return nil, err
	}
	return translator.DecodeInterfaces(raw)
}

// UpsertInterface applies an edit to an interface (addresses, description,
// MTU, VRF). Address-list changes are idempotent via delete-then-set.
func (s *Service) UpsertInterface(ctx context.Context, userID, userName, deviceID string, iface model.Interface) error {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return err
	}
	ops, err := translator.InterfaceOps(iface)
	if err != nil {
		return err
	}
	return s.runConfigure(ctx, client, userID, userName, deviceID, "interface.upsert", ops)
}

// ListGroups reads every group on the device, across all types/families.
func (s *Service) ListGroups(ctx context.Context, deviceID string) ([]model.Group, error) {
	client, err := s.cp.Get(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	raw, err := client.Retrieve(ctx, vyos.OpShowConfig, []string{"firewall", "group"})
	if err != nil {
		return nil, err
	}
	return translator.DecodeAllGroups(raw)
}
