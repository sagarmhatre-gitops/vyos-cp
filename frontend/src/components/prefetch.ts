import type { QueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

// prefetchForPath warms the react-query cache for a device sub-tab when the
// user hovers its nav link, so the data is already loading (often done) by the
// time they click. Respects staleTime automatically — hovering a tab whose
// data is still fresh is a no-op. Unknown paths are ignored (graceful miss).
//
// Keys/fns mirror each page's useQuery. If a page changes its key, prefetch
// simply misses and the normal on-mount fetch takes over — never breaks.
export function prefetchForPath(qc: QueryClient, id: string, to: string) {
  if (!id) return
  // Match on the path suffix so we don't care about the leading /devices/{id}.
  const warm = (queryKey: unknown[], queryFn: () => Promise<unknown>) => {
    qc.prefetchQuery({ queryKey, queryFn }).catch(() => {})
  }

  if (/\/firewall\//.test(to)) {
    // Firewall lands on ipv4 by default.
    warm(['rulesets', id, 'ipv4'], () => api.listRuleSets(id, 'ipv4'))
  } else if (/\/groups$/.test(to)) {
    warm(['groups', id], () => api.listGroups(id))
  } else if (/\/zones$/.test(to)) {
    warm(['zones', id], () => api.getZones(id))
  } else if (/\/nat$/.test(to)) {
    // NAT defaults to the 'source' direction.
    warm(['nat', id, 'source'], () => api.listNAT(id, 'source'))
    warm(['interfaces', id], () => api.listInterfaces(id))
  } else if (/\/interfaces$/.test(to)) {
    warm(['interfaces', id], () => api.listInterfaces(id))
  } else if (/\/qos$/.test(to)) {
    warm(['qos', id], () => api.listTrafficPolicies(id))
  } else if (/\/snmp$/.test(to)) {
    warm(['snmp', id], () => api.getSNMPConfig(id))
  } else if (/\/ipsec$/.test(to)) {
    warm(['ipsec', id], () => api.getIPsec(id))
  }
}
