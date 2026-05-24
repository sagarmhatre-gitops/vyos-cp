# Building vyos-cp from source

## Prerequisites

- Docker + Docker Compose (for `make up`)
- Or: Go 1.22+, Node 20+, Postgres 16+ (for local dev)

## First-time build (Docker Compose path — recommended)

```bash
make keys          # generates .env with fresh encryption keys
make up            # builds and starts everything
make logs          # watch it come up
```

Open <http://localhost:8080>, click "First-time setup →" to create the
admin user.

## First-time build (local dev path)

The project ships without a committed `go.sum` so that Go's module system
regenerates it for your exact toolchain. On first `go build`:

```bash
cd backend
go mod tidy        # fetches deps, generates go.sum
go test ./...      # sanity check
go build ./cmd/vyos-cp
```

For the frontend:

```bash
cd frontend
npm install        # generates package-lock.json
npm run build      # writes into backend/cmd/vyos-cp/static/
```

Then run the backend (needs Postgres at $VYOS_CP_DSN):

```bash
export VYOS_CP_SEAL_KEY=$(openssl rand -hex 32)
export VYOS_CP_JWT_KEY=$(openssl rand -hex 32)
export VYOS_CP_DSN="postgres://vyoscp:vyoscp@localhost:5432/vyoscp?sslmode=disable"
./vyos-cp
```

## Things you might hit on first build

**Backend**

- `go mod tidy` needs network access to fetch modules. If you're in an
  airgapped environment, pre-populate `$GOMODCACHE`.
- If a dependency version has been yanked upstream, `go mod tidy` will
  auto-pick a newer patch. That's fine.
- The `//go:embed` directive needs at least one file matching the glob at
  build time. `backend/cmd/vyos-cp/static/` ships with an `index.html`
  placeholder so the backend always builds — run `make frontend` to
  replace it with the real UI.

**Frontend**

- Vite 5 targets ES2020+. If you need to support older browsers, edit
  `frontend/tsconfig.json` and add a `target` build option to
  `vite.config.ts`.
- The UI talks to the backend via relative paths (`/api`, `/ws`). In dev
  mode, `vite.config.ts` proxies these to `localhost:8080`. In production,
  the Go binary serves both the API and the embedded static SPA on the
  same port, so there's nothing to configure.

**Database**

- First startup runs the embedded migration. If you're upgrading from a
  previous version of vyos-cp that used a different schema, blow the
  database away — we don't ship schema migrations yet.

## Running tests

```bash
cd backend && go test ./...
```

There are round-trip tests for the translator (encode ↔ decode symmetry),
the firewall output parser, and the at-rest sealer. These run in under a
second and don't need a database or any VyOS device.
