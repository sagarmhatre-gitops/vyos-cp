.PHONY: help up down logs build rebuild frontend backend test clean keys lint backup

help:
	@echo "vyos-cp — common targets:"
	@echo "  make keys       Generate the one-off seal + JWT keys for .env"
	@echo "  make up         Start the stack (db + app) via docker compose"
	@echo "  make down       Stop the stack"
	@echo "  make rebuild    Down + build --no-cache + up (use after applying patches)"
	@echo "  make logs       Tail the app logs"
	@echo "  make build      Rebuild the docker image"
	@echo "  make frontend   Build just the frontend into backend/cmd/vyos-cp/static"
	@echo "  make backend    Build just the Go binary (needs frontend built first)"
	@echo "  make test       Run backend tests"
	@echo "  make backup     Snapshot source + database to /opt/vyos-cp-backups"
	@echo "  make clean      Remove build artefacts"

keys:
	@if [ -f .env ]; then echo ".env already exists — refusing to overwrite"; exit 1; fi
	@echo "VYOS_CP_SEAL_KEY=$$(openssl rand -hex 32)"  >  .env
	@echo "VYOS_CP_JWT_KEY=$$(openssl rand -hex 32)"   >> .env
	@echo "Wrote .env with fresh keys. Keep it out of version control."

up:
	@if [ ! -f .env ]; then echo "Missing .env — run 'make keys' first"; exit 1; fi
	docker compose --env-file .env up -d --build

down:
	docker compose down

logs:
	docker compose logs -f app

build:
	docker compose build

# Force a clean rebuild of the app image. Use this after applying any
# tarball that contains backend (Go) changes. `make up` alone may serve a
# cached image when Docker thinks nothing material has changed in the
# build context — this target is the unambiguous "rebuild from source".
rebuild:
	docker compose down
	docker compose build --no-cache app
	docker compose up -d
	@echo "Waiting 6 seconds for app to come up..."
	@sleep 6
	docker compose logs app --tail=30

# Snapshot of source tree + .env + database dump into /opt/vyos-cp-backups.
# Run before applying patches you want to be able to roll back.
backup:
	@OUT=/opt/vyos-cp-backups; mkdir -p $$OUT; \
	TS=$$(date +%Y%m%d-%H%M%S); \
	echo "[1/3] Dumping database..."; \
	docker compose exec -T db pg_dump -U vyoscp -d vyoscp \
	  --clean --if-exists --no-owner > $$OUT/db-$$TS.sql; \
	echo "[2/3] Tarring source + .env + db..."; \
	tar czf $$OUT/vyos-cp-$$TS.tar.gz \
	  --exclude='./frontend/node_modules' \
	  --exclude='./frontend/dist' \
	  --exclude='./.git' \
	  -C $$(pwd) . \
	  -C $$OUT db-$$TS.sql; \
	rm $$OUT/db-$$TS.sql; \
	echo "[3/3] Done:"; \
	ls -lh $$OUT/vyos-cp-$$TS.tar.gz

frontend:
	cd frontend && npm install && npx vite build

backend:
	cd backend && go build -o ../bin/vyos-cp ./cmd/vyos-cp

test:
	cd backend && go test ./...

lint:
	cd backend && go vet ./...

clean:
	rm -rf bin frontend/dist backend/cmd/vyos-cp/static/*
	@mkdir -p backend/cmd/vyos-cp/static
	@echo '<!doctype html><title>vyos-cp</title><p>Frontend not built.</p>' > backend/cmd/vyos-cp/static/index.html
