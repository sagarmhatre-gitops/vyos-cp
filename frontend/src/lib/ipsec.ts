// IPsec types + API methods. Append these to frontend/src/lib/api.ts.
// They mirror the existing NAT/Zones types and methods.

export type IKEProposal = {
  number: number;
  encryption: string;          // aes128 | aes256 | aes128gcm128 | ...
  hash: string;                // sha1 | sha256 | sha384 | sha512
  dh_group: string;            // 2 | 14 | 19 | 20 | ...
  prf?: string;
};

export type DPDAction = 'hold' | 'clear' | 'restart';

export type DPD = {
  action: DPDAction;
  interval?: number;
  timeout?: number;
};

export type IKEMode = 'main' | 'aggressive';

export type IKEGroup = {
  name: string;
  description?: string;
  lifetime?: number;
  ike_version?: 'ikev1' | 'ikev2' | '';
  mode?: IKEMode;
  dead_peer_detection?: DPD;
  proposals: IKEProposal[];
};

export type ESPProposal = {
  number: number;
  encryption: string;
  hash?: string;               // empty for AEAD ciphers
};

export type ESPMode = 'tunnel' | 'transport';

export type ESPGroup = {
  name: string;
  description?: string;
  lifetime?: number;
  mode?: ESPMode;
  pfs?: string;                // enable | disable | dh-group2 | dh-group14
  proposals: ESPProposal[];
};

export type AuthMode = 'pre-shared-secret' | 'rsa' | 'x509';
export type IDType   = 'address' | 'fqdn' | 'user-fqdn' | 'keyid';

export type PeerAuth = {
  mode: AuthMode;
  pre_shared_secret?: string;       // write-only on the wire; reads return "(stored)"
  x509_certificate?: string;
  x509_ca_name?: string;
  local_id?: string;
  remote_id?: string;
  id_type?: IDType;
};

export type Tunnel = {
  number: number;
  disable?: boolean;
  description?: string;
  esp_group?: string;               // override peer.default_esp_group
  protocol?: string;
  local_subnet?: string;            // CIDR
  local_port?: string;
  remote_subnet?: string;           // CIDR
  remote_port?: string;
};

export type Peer = {
  name: string;
  description?: string;
  disable?: boolean;
  remote_address: string;           // IP | FQDN | "any"
  local_address?: string;
  ike_group: string;
  default_esp_group?: string;
  authentication: PeerAuth;
  tunnels?: Tunnel[];
  vti_interface?: string;
};

export type IPsecGlobals = {
  interfaces?: string[];
  nat_traversal: boolean;
  log_level?: number;
};

export type IPsecConfig = {
  globals: IPsecGlobals;
  ike_groups?: IKEGroup[];
  esp_groups?: ESPGroup[];
  peers?: Peer[];
};

export type SAStatus = {
  peer: string;
  tunnel: number;
  state: 'up' | 'down' | 'connecting';
  local_net?: string;
  remote_net?: string;
  bytes_in: number;
  bytes_out: number;
  packets_in: number;
  packets_out: number;
  uptime_sec?: number;
};

/*
  Add the following methods to the existing `Api` class in api.ts. They
  follow the same `req<T>(...)` shape used by listNAT / upsertNATRule.

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
  deletePeer(id: string, name: string) {
    return this.req<void>(`/api/v1/devices/${id}/ipsec/peers/${encodeURIComponent(name)}`,
      { method: 'DELETE' });
  }
*/
