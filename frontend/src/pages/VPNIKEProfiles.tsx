import { VPNProfilesPage } from './VPNProfilesPage'

// Thin wrapper — all the real logic lives in VPNProfilesPage. Phase 2
// extensions (per-type-only behavior, if any) would localize here.
export function VPNIKEProfiles() {
  return <VPNProfilesPage type="ike" />
}
