# vyos-cp

A fleet control plane for VyOS firewalls. One web UI and REST API to manage
rule-sets, groups, zones, NAT, and audit trails across many VyOS devices.

Inspired by haproxy-control-plane. Production-shaped. Works against real
VyOS 1.4 and 1.5 devices.

## What you get

- **Rule-set editor** (IPv4 + IPv6) with live diff preview before every commit
- **Groups manager** — address / network / port / domain / MAC / interface
- **Zones & policies** with a from→to policy matrix
- **NAT** editor for source and destination rules
- **GeoIP** country-based match on source or destination
- **Live fleet status** via WebSocket (status, counters, version drift)
- **Audit log** — every device write, who ran it, the exact VyOS ops committed
- **Templates & fleet push** — define a rule-set once, push to N devices in parallel
- **RBAC** — admin / operator / viewer roles
- **Commit-confirm** — writes auto-revert unless confirmed, so a bad rule
  can't lock you out

## Architecture

```
┌──────────┐  HTTPS   ┌─────────────┐  VyOS HTTP API   ┌─────────────┐
│  Browser │  + JWT   │   vyos-cp   │  + commit-confirm│   VyOS fleet│
│          ├─────────▶│  (Go + SPA) ├─────────────────▶│ 1.4 / 1.5   │
└──────────┘          └──────┬──────┘                  └─────────────┘
                             │
                             ▼
                       ┌──────────┐
                       │ Postgres │   devices, audit, templates, users
                       └──────────┘
```

The Go binary embeds the React frontend. One container, plus Postgres.

## Quick start (Docker Compose)

```bash
# 1. Clone the repo
git clone <your-fork> vyos-cp && cd vyos-cp

# 2. Generate the one-off encryption keys
make keys          # writes .env with VYOS_CP_SEAL_KEY + VYOS_CP_JWT_KEY

# 3. Start the stack
make up

# 4. Watch it come up
make logs
```

Open <http://localhost:8080>. On first launch, click **First-time setup →**
to create the admin user, then sign in.

## Configuring VyOS devices

Each VyOS device needs the HTTP API enabled and a key created for vyos-cp.
See [docs/vyos-setup.md](docs/vyos-setup.md) for the exact commands.

Short version — on each VyOS device:

```bash
configure
set pki certificate vyos-cp-api self-signed
set service https certificates certificates certificate vyos-cp-api
set service https api rest
set service https api keys id vyos-cp key 'LONG-RANDOM-SECRET'
commit
save
exit
```

Then in the UI: **Devices → + Add device**.

## Configuration

All settings are environment variables. Defaults in `docker-compose.yml`.

| Variable | Default | Purpose |
|---|---|---|
| `VYOS_CP_DSN` | `postgres://vyoscp:vyoscp@db:5432/vyoscp?sslmode=disable` | Postgres DSN |
| `VYOS_CP_SEAL_KEY` | (required) | 32 bytes hex, seals device API keys at rest |
| `VYOS_CP_JWT_KEY`  | (required) | 32 bytes hex, signs user session JWTs |
| `VYOS_CP_COMMIT_CONFIRM_MINUTES` | `1` | Auto-revert window; `0` disables |
| `VYOS_CP_POLL_INTERVAL_SEC` | `10` | Device health + counter poll cadence |
| `VYOS_CP_LISTEN` | `:8080` | Listen address |

Generate keys with `make keys`, or manually: `openssl rand -hex 32`.

## Development

```bash
# Backend
cd backend
go test ./...
go run ./cmd/vyos-cp            # expects Postgres running locally

# Frontend (hot reload, proxies /api and /ws to :8080)
cd frontend
npm install
npm run dev                     # opens http://localhost:5173
```

## REST API

Selected endpoints — everything under `/api/v1` requires `Authorization: Bearer <jwt>`:

```
POST   /auth/bootstrap                          # one-shot, only when no users exist
POST   /auth/login                              # { email, password } -> { token, user }

GET    /devices
POST   /devices                                 # pre-flight-verifies the device
GET    /devices/{id}
DELETE /devices/{id}

GET    /devices/{id}/firewall/{family}/rulesets
GET    /devices/{id}/firewall/{family}/rulesets/{name}
PUT    /devices/{id}/firewall/{family}/rulesets/{name}/rules/{n}
DELETE /devices/{id}/firewall/{family}/rulesets/{name}/rules/{n}
POST   /devices/{id}/firewall/groups

GET    /devices/{id}/nat/{source|destination}
PUT    /devices/{id}/nat/{direction}/{n}
DELETE /devices/{id}/nat/{direction}/{n}

GET    /devices/{id}/zones
POST   /devices/{id}/zones
POST   /devices/{id}/zones/policy

GET    /audit?device_id=...&limit=100
GET    /templates
POST   /templates
POST   /templates/{name}/push                   # { device_ids: [...] }

WS     /api/v1/ws?token=<jwt>&device_id=<optional>
```

## Safety model

1. The browser never talks to VyOS directly — all writes go through vyos-cp.
2. Every domain-level change becomes **one atomic** `/configure` call, so
   VyOS commits all ops or none.
3. Every commit is a **commit-confirm**. If the follow-up confirm doesn't
   land within the window, VyOS rolls back.
4. Every write lands in `audit_log` with user, device, the exact ops, and
   outcome.
5. Device API keys are **sealed at rest** with NaCl secretbox using a master
   key from `VYOS_CP_SEAL_KEY`.
6. Fleet pushes run per-device in parallel and **report per-device success /
   failure** rather than aborting on first error.

## Project layout

```
backend/
  cmd/vyos-cp/               entrypoint + embedded static SPA
  internal/
    vyos/                    typed VyOS HTTP client + show-firewall parser
    vyos/translator/         domain <-> VyOS path translator (encode + decode)
    model/                   domain types
    store/                   pgx-backed Postgres layer
    crypto/                  at-rest sealer (NaCl secretbox)
    service/                 business logic, client pool, RBAC
    poller/                  device health + counters, WebSocket pub/sub
    api/                     chi router, JWT auth, WebSocket handler
  migrations/                SQL schema
frontend/
  src/
    pages/                   Dashboard, Devices, RuleSetEditor, Groups, Zones, NAT, Audit, Templates, Login
    lib/api.ts               thin API client + WebSocket hook
    App.tsx                  routing, auth guard, shell
    index.css                design tokens (light + dark)
Dockerfile                   multi-stage: frontend -> Go binary -> distroless
docker-compose.yml           Postgres + app
Makefile                     make keys / up / down / logs / test
docs/vyos-setup.md           VyOS device enablement
```

## What's not in v1 (coming later)

- Config drift detection and reconciliation
- Git-backed snapshots + rollback across commits
- Interactive per-rule counter streaming in the editor
- Threat-feed ingestion (Spamhaus, Emerging Threats, etc.)
- Full user-management UI (backend has create-user; UI is minimal)
- K8s Helm chart

## License

MIT.
# vyos-cp
