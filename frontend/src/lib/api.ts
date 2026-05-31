// Thin API client. Throws on non-2xx with the server's error message.

export type MetricsSample = {
  bucket: string;       // RFC3339 timestamp
  cpu_pct?: number;
  cpu_pct_5m?: number;
  cpu_pct_15m?: number;
  mem_used_mb?: number;
  mem_total_mb?: number;
  sessions?: number;
};

export type DeviceOverview = {
  memory_total_mb?: number;
  memory_used_mb?: number;
  memory_free_mb?: number;
  load_1?: number;
  load_5?: number;
  load_15?: number;
  session_count?: number;
  uptime_seconds?: number;
  version_details?: string;
  raw_memory?: string;
  raw_uptime?: string;
  raw_sessions?: string;
};

export type SearchHit = {
  kind: 'device' | 'user';
  id: string;
  title: string;
  subtitle: string;
};

// FleetHealth — server-computed rollup for the dashboard. Donut + alert
// tiles read from this single endpoint instead of per-device metric scans.
export type FleetHealth = {
  total: number;
  healthy: number;
  warning: number;
  critical: number;
  stale: number;
  unknown: number;
};

export type Device = {
  id: string; name: string; address: string;
  status: string; version?: string; hostname?: string;
  last_seen?: string; last_error?: string;
  tags?: string[]; location?: string; insecure_skip_verify?: boolean;
  // Latest minute-bucket throughput, attached server-side to listDevices
  // responses. Null if no recent sample.
  throughput?: {
    ts: string;
    rx_bps: number; tx_bps: number;
    rx_pps: number; tx_pps: number;
  };
};

export type User = {
  id: string;
  email: string;
  display_name: string;
  roles: string[];
  disabled?: boolean;
  created_at: string;
};

export type Rule = {
  number: number; description?: string; action: string;
  protocol?: string;
  source?: AddrSpec; destination?: AddrSpec;
  state?: { established?: boolean; related?: boolean; new?: boolean; invalid?: boolean };
  log?: boolean; disable?: boolean;
  jump_target?: string;
  source_countries?: string[]; destination_countries?: string[];
};

export type AddrSpec = {
  address?: string; port?: string; mac?: string;
  group?: {
    address_group?: string; network_group?: string; port_group?: string;
    domain_group?: string; mac_group?: string; interface_group?: string;
  };
};

export type RuleSet = {
  name: string; family: string; default_action: string;
  description?: string; rules?: Rule[];
};

export type Group = {
  name: string; type: string; family?: string;
  description?: string; members: string[];
};

export type NATRule = {
  number: number; direction: 'source' | 'destination';
  description?: string; disable?: boolean; protocol?: string;
  inbound_interface?: string; outbound_interface?: string;
  source?: AddrSpec; destination?: AddrSpec;
  translation_address?: string; translation_port?: string;
  log?: boolean;
};

export type Zone = { name: string; description?: string; interfaces?: string[]; local_zone?: boolean; default_action?: string };
export type ZonePolicy = { from_zone: string; to_zone: string; rule_set: string; family: string };

export type IfaceRate = {
  rx_bps: number; tx_bps: number;
  rx_pps: number; tx_pps: number;
};

export type UsageRollup = {
  device_id: string;
  scope: string;
  period_type: string;
  period_start: string;
  rx_bytes: number;
  tx_bytes: number;
  had_reset: boolean;
  source: string;
};

export type ThroughputSample = {
  ts: string;
  total: IfaceRate;
  per: Record<string, IfaceRate>;
};

export type Interface = {
  kind: string;
  name: string;
  description?: string;
  addresses?: string[];
  mtu?: string;
  vrf?: string;
  hw_id?: string;
  disabled?: boolean;
  link_state?: string;
  rx_bytes?: number;
  tx_bytes?: number;
};

// QoS types
export type QoSEngine = 'htb' | 'hfsc' | 'fq-codel';

export type ClassMatcher = {
  name: string;
  description?: string;
  protocol?: string;
  source_address?: string; source_port?: string;
  dest_address?: string;   dest_port?: string;
  dscp?: string;
  mark?: string;
  vif?: number;
  tcp_flags?: string[];
};

export type TrafficClass = {
  id: number;
  description?: string;
  bandwidth: string;
  ceiling?: string;
  priority?: number;
  burst?: string;
  queue?: string;
  matchers?: ClassMatcher[];
};

export type TrafficPolicy = {
  name: string;
  engine: QoSEngine;
  description?: string;
  bandwidth?: string;
  classes?: TrafficClass[];
  default_bandwidth?: string;
  default_ceiling?: string;
  default_priority?: number;
  default_queue?: string;
  codel_target?: string;
  codel_interval?: string;
};

export type TrafficPolicyBinding = {
  policy_name: string;
  interface: string;
  kind?: string;
  direction?: 'egress' | 'ingress' | 'in' | 'out';
  shape_ingress?: boolean;
  ifb?: string;
};

// SNMP types
export type SNMPVersion = 'v2c' | 'v3';

export type SNMPCommunity = {
  name: string;
  authorization?: 'ro' | 'rw';
  clients?: string[];
  network?: string[];
};

export type SNMPV3User = {
  name: string;
  group?: string;
  auth_protocol?: string;
  auth_password?: string;
  auth_encrypted?: string;
  priv_protocol?: string;
  priv_password?: string;
  priv_encrypted?: string;
  engine_id?: string;
  tp_mode?: string;
};

export type SNMPV3Group = {
  name: string;
  mode: 'ro' | 'rw';
  sec_level?: string;
  view?: string;
};

export type SNMPV3View = {
  name: string;
  oids?: string[];
  mask?: string;
  exclude?: boolean;
};

export type SNMPTrapTarget = {
  address: string;
  port?: number;
  version: SNMPVersion;
  community?: string;
  v3_user?: string;
  v3_engine_id?: string;
  type?: 'trap' | 'inform';
};

export type SNMPConfig = {
  contact?: string;
  location?: string;
  description?: string;
  listen_addresses?: string[];
  listen_port?: number;
  communities?: SNMPCommunity[];
  v3_users?: SNMPV3User[];
  v3_groups?: SNMPV3Group[];
  v3_views?: SNMPV3View[];
  trap_targets?: SNMPTrapTarget[];
  engine_id?: string;
  vrf?: string;
};

export type AuditEntry = {
  id: number; timestamp: string; user_id?: string; user_name?: string;
  device_id?: string; device?: string; action: string;
  ops?: Array<{ op: string; path: string[]; value?: string }>;
  success: boolean; error_msg?: string;
};


// --- IPsec ----------------------------------------------------------------

export type IKEProposal = {
  number: number; encryption: string; hash: string; dh_group: string; prf?: string;
};
export type DPDAction = 'hold' | 'clear' | 'restart';
export type DPD = { action: DPDAction; interval?: number; timeout?: number };
export type IKEMode = 'main' | 'aggressive';
export type IKEGroup = {
  name: string; description?: string; lifetime?: number;
  ike_version?: 'ikev1' | 'ikev2' | ''; mode?: IKEMode;
  dead_peer_detection?: DPD; proposals: IKEProposal[];
};
export type ESPProposal = { number: number; encryption: string; hash?: string };
export type ESPMode = 'tunnel' | 'transport';
export type ESPGroup = {
  name: string; description?: string; lifetime?: number;
  mode?: ESPMode; pfs?: string; proposals: ESPProposal[];
};
export type AuthMode = 'pre-shared-secret' | 'rsa' | 'x509';
export type IDType = 'address' | 'fqdn' | 'user-fqdn' | 'keyid';
export type PeerAuth = {
  mode: AuthMode; pre_shared_secret?: string;
  x509_certificate?: string; x509_ca_name?: string;
  local_id?: string; remote_id?: string; id_type?: IDType;
};
export type Tunnel = {
  number: number; disable?: boolean; description?: string;
  esp_group?: string; protocol?: string;
  local_subnet?: string; local_port?: string;
  remote_subnet?: string; remote_port?: string;
};
export type Peer = {
  name: string; description?: string; disable?: boolean;
  remote_address: string; local_address?: string;
  ike_group: string; default_esp_group?: string;
  authentication: PeerAuth; tunnels?: Tunnel[]; vti_interface?: string;
};
export type IPsecGlobals = {
  interfaces?: string[]; nat_traversal: boolean; log_level?: number;
};
export type IPsecConfig = {
  globals: IPsecGlobals; ike_groups?: IKEGroup[];
  esp_groups?: ESPGroup[]; peers?: Peer[];
};
export type SAStatus = {
  peer: string; tunnel: number; state: 'up' | 'down' | 'connecting';
  local_net?: string; remote_net?: string;
  bytes_in: number; bytes_out: number;
  packets_in: number; packets_out: number; uptime_sec?: number;
};

// --- VPN profiles (Phase 1) -------------------------------------------------

export type VPNProfile = {
  id: string
  type: 'ike' | 'esp'
  name: string
  device_id: string
  device_name?: string
  ike?: IKEGroup
  esp?: ESPGroup
  description: string
  tags: string[]
  created_by?: string
  updated_by?: string
  created_at?: string
  updated_at?: string
  used_by: string[]
}

export type VPNProfileCreate = {
  device_id: string
  type: 'ike' | 'esp'
  ike?: IKEGroup
  esp?: ESPGroup
  description: string
  tags: string[]
}

export type VPNProfileUpdate = {
  ike?: IKEGroup
  esp?: ESPGroup
  description: string
  tags: string[]
}

// --- VPN peers (Phase 3A) ---------------------------------------------------

export type VPNPeer = {
  id: string
  name: string
  device_id: string
  device_name?: string
  peer?: Peer
  description: string
  tags: string[]
  created_by?: string
  updated_by?: string
  created_at?: string
  updated_at?: string
  used_by: string[]
}

class API {
  private token: string | null = null;
  constructor() {
    this.token = localStorage.getItem('vyos-cp.token');
  }
  setToken(t: string | null) {
    this.token = t;
    if (t) localStorage.setItem('vyos-cp.token', t);
    else localStorage.removeItem('vyos-cp.token');
  }
  getToken() { return this.token; }

  async req<T = any>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as any),
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(path, { ...init, headers });
    if (res.status === 204) return undefined as unknown as T;
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
    if (!res.ok) {
      const msg = body?.error ?? res.statusText;
      throw new Error(msg);
    }
    return body as T;
  }

  // Auth
  bootstrap(email: string, password: string, displayName: string) {
    return this.req<{ token: string; user: any }>('/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
  }
  login(email: string, password: string) {
    return this.req<{ token: string; user: any }>('/api/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
  }

  // Devices
  listDevices() { return this.req<Device[]>('/api/v1/devices'); }
  getDevice(id: string) { return this.req<Device>(`/api/v1/devices/${id}`); }
  addDevice(body: any) {
    return this.req<Device>('/api/v1/devices', { method: 'POST', body: JSON.stringify(body) });
  }
  deleteDevice(id: string) {
    return this.req<void>(`/api/v1/devices/${id}`, { method: 'DELETE' });
  }

  // Firewall
  listRuleSets(id: string, family: string) {
    return this.req<RuleSet[]>(`/api/v1/devices/${id}/firewall/${family}/rulesets`);
  }
  getRuleSet(id: string, family: string, name: string) {
    return this.req<RuleSet>(`/api/v1/devices/${id}/firewall/${family}/rulesets/${name}`);
  }
  upsertRule(id: string, family: string, name: string, rule: Rule) {
    return this.req<Rule>(`/api/v1/devices/${id}/firewall/${family}/rulesets/${name}/rules/${rule.number}`, {
      method: 'PUT', body: JSON.stringify(rule),
    });
  }
  deleteRule(id: string, family: string, name: string, number: number) {
    return this.req<void>(`/api/v1/devices/${id}/firewall/${family}/rulesets/${name}/rules/${number}`, { method: 'DELETE' });
  }

  // ── Rule simulation + shadow detection ──────────────────────────────────
  simulatePacket(id: string, family: string, name: string, packet: any) {
    return this.req(`/api/v1/devices/${id}/firewall/${family}/rulesets/${name}/simulate`,
      { method: 'POST', body: JSON.stringify(packet) });
  }
  shadowAnalysis(id: string, family: string, name: string) {
    return this.req(`/api/v1/devices/${id}/firewall/${family}/rulesets/${name}/shadow`);
  }
  translatePreview(id: string, family: string, name: string, rule: any) {
    return this.req(`/api/v1/devices/${id}/firewall/${family}/rulesets/${name}/translate-preview`,
      { method: 'POST', body: JSON.stringify(rule) });
  }
  getLatestSnapshotCLI(id: string) {
    return this.req<{ taken_at: string; config_hash: string; cli: string }>(
      `/api/v1/devices/${id}/snapshot/cli`,
    );
  }
  upsertGroup(id: string, g: Group) {
    return this.req<Group>(`/api/v1/devices/${id}/firewall/groups`, {
      method: 'POST', body: JSON.stringify(g),
    });
  }

  // NAT
  listNAT(id: string, direction: 'source' | 'destination') {
    return this.req<NATRule[]>(`/api/v1/devices/${id}/nat/${direction}`);
  }
  upsertNAT(id: string, rule: NATRule) {
    return this.req<NATRule>(`/api/v1/devices/${id}/nat/${rule.direction}/${rule.number}`, {
      method: 'PUT', body: JSON.stringify(rule),
    });
  }

  // Interfaces
  listInterfaces(id: string) {
    return this.req<Interface[]>(`/api/v1/devices/${id}/interfaces`);
  }
  upsertInterface(id: string, iface: Interface) {
    return this.req<Interface>(`/api/v1/devices/${id}/interfaces/${iface.kind}/${iface.name}`, {
      method: 'PUT', body: JSON.stringify(iface),
    });
  }

  // ---- Snapshots (Ship 1) -------------------------------------------------
  // Latest decoded VyOS config for a device. 404 = no snapshot captured yet
  // (the poller writes one on startup, then every ~5 minutes by default).
  getLatestSnapshot(id: string) {
    return this.req<DeviceSnapshot>(`/api/v1/devices/${id}/snapshot`);
  }
  // Lightweight history (no config_json). For Ship 2's diff picker.
  listSnapshots(id: string, limit = 50) {
    return this.req<SnapshotSummary[]>(`/api/v1/devices/${id}/snapshots?limit=${limit}`);
  }
  // Force a synchronous capture. Backend RBAC requires operator/admin.
  captureSnapshotNow(id: string) {
    return this.req<DeviceSnapshot>(`/api/v1/devices/${id}/snapshot`, { method: 'POST' });
  }

  // Ship 2 — fetch a specific historical snapshot (full config).
  getSnapshotByID(deviceID: string, snapshotID: number) {
    return this.req<DeviceSnapshot>(
      `/api/v1/devices/${deviceID}/snapshots/${snapshotID}`,
    );
  }

  // Ship 2 — compute the diff between two snapshots. `to` defaults to 'latest'.
  computeDiff(
    deviceID: string,
    fromID: number,
    toID: number | 'latest' = 'latest',
  ) {
    const t = typeof toID === 'number' ? String(toID) : toID;
    return this.req<SnapshotDiff>(
      `/api/v1/devices/${deviceID}/diff?from=${fromID}&to=${t}`,
    );
  }

  // Groups
  listGroups(id: string) {
    return this.req<Group[]>(`/api/v1/devices/${id}/firewall/groups`);
  }

  // Throughput
  deviceThroughput(id: string) {
    return this.req<ThroughputSample[]>(`/api/v1/devices/${id}/throughput`);
  }
  fleetThroughput() {
    return this.req<IfaceRate>(`/api/v1/fleet/throughput`);
  }
  deviceUsage(id: string, period: 'hour' | 'day' | 'month' = 'hour', hours = 24) {
    return this.req<UsageRollup[]>(`/api/v1/devices/${id}/usage?period=${period}&hours=${hours}`);
  }
  deviceFlows(id: string, limit = 500) {
    return this.req<Array<{
      conntrack_id: string; protocol: string; state: string;
      orig_src_ip: string; orig_src_port: string; orig_dst_ip: string; orig_dst_port: string;
      reply_src_ip: string; reply_dst_ip: string; timeout_sec: number;
    }>>(`/api/v1/devices/${id}/flows?limit=${limit}`);
  }
  deviceThroughputHistory(id: string, hours = 24) {
    return this.req<Array<{ ts: string; rx_bps: number; tx_bps: number; rx_pps: number; tx_pps: number }>>(
      `/api/v1/devices/${id}/throughput/history?hours=${hours}`);
  }
  fleetThroughputHistory(hours = 24) {
    return this.req<Array<{ ts: string; rx_bps: number; tx_bps: number; rx_pps: number; tx_pps: number }>>(
      `/api/v1/fleet/throughput/history?hours=${hours}`);
  }

  // QoS
  listTrafficPolicies(id: string) {
    return this.req<TrafficPolicy[]>(`/api/v1/devices/${id}/qos/policies`);
  }
  upsertTrafficPolicy(id: string, p: TrafficPolicy) {
    return this.req<TrafficPolicy>(`/api/v1/devices/${id}/qos/policies/${p.name}`, {
      method: 'PUT', body: JSON.stringify(p),
    });
  }
  deleteTrafficPolicy(id: string, engine: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/qos/policies/${engine}/${name}`, { method: 'DELETE' });
  }
  bindTrafficPolicy(id: string, b: TrafficPolicyBinding) {
    return this.req<TrafficPolicyBinding>(`/api/v1/devices/${id}/qos/bind`, {
      method: 'POST', body: JSON.stringify(b),
    });
  }
  unbindTrafficPolicy(id: string, b: TrafficPolicyBinding) {
    return this.req<void>(`/api/v1/devices/${id}/qos/unbind`, {
      method: 'POST', body: JSON.stringify(b),
    });
  }
  listQoSBindings(id: string) {
    return this.req<TrafficPolicyBinding[]>(`/api/v1/devices/${id}/qos/bindings`);
  }
  cleanupQoSOrphans(id: string) {
    return this.req<{ cleaned: number }>(`/api/v1/devices/${id}/qos/cleanup`,
      { method: 'POST' });
  }
  search(q: string) {
    return this.req<SearchHit[]>(`/api/v1/search?q=${encodeURIComponent(q)}`);
  }
  getFleetHealth() {
    return this.req<FleetHealth>(`/api/v1/fleet/health`);
  }
  // pingDevice / tracerouteDevice removed in v28 — VyOS HTTP API doesn't
  // expose these op-mode commands. Will return when an SSH-based code path
  // is added in a later phase.
  rebootDevice(id: string, deviceName: string) {
    return this.req<{ status: string }>(`/api/v1/devices/${id}/reboot`,
      { method: 'POST', headers: { 'X-Confirm-Device': deviceName } });
  }
  // Backup config — fetches text/plain, triggers a browser download. We
  // can't use a plain <a href> because the request needs the JWT bearer
  // header; instead we fetch + blob + click a synthetic anchor.
  async downloadBackup(id: string, filename: string): Promise<void> {
    const r = await fetch(`/api/v1/devices/${id}/backup`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Backup failed: ${r.status} ${txt}`);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  getDeviceOverview(id: string) {
    return this.req<DeviceOverview>(`/api/v1/devices/${id}/overview`);
  }
  getDeviceMetrics(id: string, fromISO?: string, toISO?: string) {
    const qs = new URLSearchParams();
    if (fromISO) qs.set('from', fromISO);
    if (toISO) qs.set('to', toISO);
    const suffix = qs.toString() ? `?${qs}` : '';
    return this.req<MetricsSample[]>(`/api/v1/devices/${id}/metrics${suffix}`);
  }

  // SNMP
  getSNMPConfig(id: string) {
    return this.req<SNMPConfig>(`/api/v1/devices/${id}/snmp`);
  }
  upsertSNMPConfig(id: string, c: SNMPConfig) {
    return this.req<SNMPConfig>(`/api/v1/devices/${id}/snmp`, {
      method: 'PUT', body: JSON.stringify(c),
    });
  }
  deleteSNMPConfig(id: string) {
    return this.req<void>(`/api/v1/devices/${id}/snmp`, { method: 'DELETE' });
  }

  // Device tags (used for production marker)
  updateDeviceTags(id: string, tags: string[]) {
    return this.req<Device>(`/api/v1/devices/${id}/tags`, {
      method: 'PUT', body: JSON.stringify({ tags }),
    });
  }

  // Device edit (name, address, hostname, api key, tls verify, tags, location)
  updateDevice(id: string, body: {
    name?: string; address?: string; hostname?: string;
    api_key?: string; insecure_skip_verify?: boolean;
    tags?: string[]; location?: string;
  }) {
    return this.req<Device>(`/api/v1/devices/${id}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
  }

  // Completeness: deletes for firewall primitives
  deleteRuleSet(id: string, family: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/firewall/${family}/name/${name}`, { method: 'DELETE' });
  }
  deleteGroup(id: string, kind: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/firewall/groups/${kind}/${name}`, { method: 'DELETE' });
  }
  deleteZone(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/zones/${name}`, { method: 'DELETE' });
  }

  // User management
  me() { return this.req<{ id: string; name: string }>(`/api/v1/me`); }
  listUsers() { return this.req<User[]>(`/api/v1/users`); }
  createUser(body: {
    email: string; display_name: string; password: string; roles: string[];
  }) {
    return this.req<User>(`/api/v1/users`, { method: 'POST', body: JSON.stringify(body) });
  }
  updateUser(id: string, body: {
    name?: string; password?: string; roles: string[];
  }) {
    return this.req<void>(`/api/v1/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  }
  deleteUser(id: string) {
    return this.req<void>(`/api/v1/users/${id}`, { method: 'DELETE' });
  }

  // Zones
  getZones(id: string) {
    return this.req<{ zones: Zone[]; policies: ZonePolicy[] }>(`/api/v1/devices/${id}/zones`);
  }
  upsertZone(id: string, z: Zone) {
    return this.req<Zone>(`/api/v1/devices/${id}/zones`, { method: 'POST', body: JSON.stringify(z) });
  }
  setZonePolicy(id: string, p: ZonePolicy) {
    return this.req<ZonePolicy>(`/api/v1/devices/${id}/zones/policy`, { method: 'POST', body: JSON.stringify(p) });
  }

  // Audit
  listAudit(deviceID = '', limit = 100) {
    const q = new URLSearchParams();
    if (deviceID) q.set('device_id', deviceID);
    q.set('limit', String(limit));
    return this.req<AuditEntry[]>(`/api/v1/audit?${q}`);
  }

  // Templates
  listTemplates() { return this.req<RuleSet[]>('/api/v1/templates'); }
  saveTemplate(rs: RuleSet) {
    return this.req<RuleSet>('/api/v1/templates', { method: 'POST', body: JSON.stringify(rs) });
  }
  pushTemplate(name: string, deviceIDs: string[]) {
    return this.req<Record<string, { status: string; error?: string }>>(`/api/v1/templates/${name}/push`, {
      method: 'POST', body: JSON.stringify({ device_ids: deviceIDs }),
    });
  }
  deleteTemplate(name: string) {
    return this.req<void>(`/api/v1/templates/${name}`, { method: 'DELETE' });
  }
  getIPsec(id: string) {
    return this.req<IPsecConfig>(`/api/v1/devices/${id}/ipsec`);
  }
  getIPsecStatus(id: string) {
    return this.req<SAStatus[]>(`/api/v1/devices/${id}/ipsec/status`);
  }
  setIPsecGlobals(id: string, g: IPsecGlobals) {
    return this.req<IPsecGlobals>(`/api/v1/devices/${id}/ipsec/globals`,
      { method: 'PUT', body: JSON.stringify(g) });
  }
  upsertIKEGroup(id: string, g: IKEGroup) {
    return this.req<IKEGroup>(`/api/v1/devices/${id}/ipsec/ike-groups/${encodeURIComponent(g.name)}`,
      { method: 'PUT', body: JSON.stringify(g) });
  }
  deleteIKEGroup(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/ike-groups/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }
  upsertESPGroup(id: string, g: ESPGroup) {
    return this.req<ESPGroup>(`/api/v1/devices/${id}/ipsec/esp-groups/${encodeURIComponent(g.name)}`,
      { method: 'PUT', body: JSON.stringify(g) });
  }
  deleteESPGroup(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/esp-groups/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }
  upsertPeer(id: string, p: Peer) {
    return this.req<Peer>(`/api/v1/devices/${id}/ipsec/peers/${encodeURIComponent(p.name)}`,
      { method: 'PUT', body: JSON.stringify(p) });
  }

  // Wizard endpoint: create IKE + ESP + peer atomically in one /configure
  // call. Used only by the Add Peer wizard. Edits use the per-object
  // upsert methods above. On failure nothing changes on the device — no
  // partial state, no cleanup needed.
  createTunnel(id: string, body: {
    ike_group?: IKEGroup
    esp_group?: ESPGroup
    peer: Peer
  }) {
    return this.req<Peer>(`/api/v1/devices/${id}/ipsec/tunnels`,
      { method: 'POST', body: JSON.stringify(body) });
  }
  deletePeer(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/peers/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }

  // --- VPN profiles (Phase 1) ----------------------------------------------
  listVPNProfiles() {
    return this.req<VPNProfile[]>(`/api/v1/vpn/profiles`);
  }
  getVPNProfile(id: string) {
    return this.req<VPNProfile>(`/api/v1/vpn/profiles/${id}`);
  }
  createVPNProfile(body: VPNProfileCreate) {
    return this.req<VPNProfile>(`/api/v1/vpn/profiles`, {
      method: 'POST', body: JSON.stringify(body),
    });
  }
  updateVPNProfile(id: string, body: VPNProfileUpdate) {
    return this.req<VPNProfile>(`/api/v1/vpn/profiles/${id}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
  }
  deleteVPNProfile(id: string) {
    return this.req<void>(`/api/v1/vpn/profiles/${id}`, { method: 'DELETE' });
  }

  // --- VPN peers (Phase 3A) ------------------------------------------------
  listVPNPeers() {
    return this.req<VPNPeer[]>(`/api/v1/vpn/peers`);
  }
  getVPNPeer(id: string) {
    return this.req<VPNPeer>(`/api/v1/vpn/peers/${id}`);
  }
  deleteVPNPeer(id: string) {
    return this.req<void>(`/api/v1/vpn/peers/${id}`, { method: 'DELETE' });
  }
}


export type SnapshotSource = 'control_plane' | 'device' | 'manual';

export type SnapshotSummary = {
  id: number;
  device_id: string;
  taken_at: string;
  source: SnapshotSource;
  config_hash: string;
};

export type DeviceSnapshot = SnapshotSummary & {
  config: Record<string, unknown>;
  parent_id?: number | null;
  audit_log_id?: number | null;
  created_by?: string | null;
};


export type DiffOp = 'add' | 'remove' | 'modify';

export type DiffChange = {
  path: string;
  op: DiffOp;
  before?: unknown;
  after?: unknown;
};

export type SnapshotDiff = {
  from: number;
  to: number;
  changes: DiffChange[];
};

export const api = new API();

// WebSocket event bus.
export type WsEvent = {
  device_id: string; kind: 'status' | 'counters' | 'throughput';
  status?: string; version?: string; hostname?: string;
  counters?: Array<{ family: string; ruleset: string; rule: number; packets: number; bytes: number; action: string }>;
  throughput?: ThroughputSample;
  ts: string;
};

export function connectWS(onEvent: (e: WsEvent) => void): () => void {
  const token = api.getToken();
  if (!token) return () => {};
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  const open = () => {
    ws = new WebSocket(url);
    ws.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (!closed) {
        reconnectTimer = window.setTimeout(open, 3000);
      }
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// Live Config — types + client methods. Add to your existing src/lib/api.ts.
// Replace `request(...)` with whatever authed-fetch helper your file already has.
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeAction = 'Added' | 'Modified' | 'Removed'

export interface SectionCount { name: string; count: number }
export interface TopSection { name: string; count: number }

export interface RecentChangeItem {
  at: string
  target: string
  description: string
  action: ChangeAction
}

export interface LiveConfig {
  snapshot_id: number
  captured_at: string
  device_id: string
  device_name: string
  config_id: string
  version: string
  source: string
  content: string
  lines: number
  size_bytes: number
  checksum: string
  last_changed: string | null
  changed_by: string
  live: boolean
  sections: SectionCount[]
  top_modified: TopSection[]
  recent_changes: RecentChangeItem[]
}

export interface ValidateResult {
  valid: boolean
  message: string
  detail: string
  validated_at: string
}

export interface SnapshotMeta {
  id: number
  captured_at: string
  config_id: string
  checksum: string
  version: string
  source: string         // 'commit' | 'manual' | 'poll'
  captured_by: string
  lines: number
  size_bytes: number
}

export interface Snapshot extends SnapshotMeta {
  device_id: string
  content: string
}

export type DiffKind = 'add' | 'del' | 'ctx'
export interface DiffLine { kind: DiffKind; text: string; a: number; b: number }
export interface DiffResult {
  from_id: number
  to_id: number
  added: number
  removed: number
  lines: DiffLine[]
  identical: boolean
}

// ── client methods — splice into the `api` object ───────────────────────────
//
//   export const api = {
//     ...existing,
//
//     getLiveConfig: (deviceId: string) =>
//       request<LiveConfig>(`/api/v1/devices/${deviceId}/live-config`),
//
//     refreshLiveConfig: (deviceId: string) =>
//       request<LiveConfig>(`/api/v1/devices/${deviceId}/live-config/refresh`, { method: 'POST' }),
//
//     validateLiveConfig: (deviceId: string) =>
//       request<ValidateResult>(`/api/v1/devices/${deviceId}/live-config/validate`, { method: 'POST' }),
//
//     listSnapshots: (deviceId: string, limit = 50) =>
//       request<SnapshotMeta[]>(`/api/v1/devices/${deviceId}/snapshots?limit=${limit}`),
//
//     getSnapshot: (deviceId: string, snapId: number) =>
//       request<Snapshot>(`/api/v1/devices/${deviceId}/snapshots/${snapId}`),
//
//     diffSnapshots: (deviceId: string, fromId: number, toId: number) =>
//       request<DiffResult>(`/api/v1/devices/${deviceId}/snapshots/diff?from=${fromId}&to=${toId}`),
//   }
