
## ── Simulation engine ────────────────────────────────────────────────────────

.PHONY: sim-test sim-bench sim-lint

sim-test:
	@echo "[sim] running simulation engine unit tests"
	docker run --rm -v $(PWD)/backend:/src -w /src golang:1.22-alpine \
		go test ./internal/simulation/... -v -count=1

sim-bench:
	@echo "[sim] benchmark: rule evaluation throughput"
	docker run --rm -v $(PWD)/backend:/src -w /src golang:1.22-alpine \
		go test ./internal/simulation/... -bench=. -benchmem -run=^$$

sim-lint:
	@echo "[sim] staticcheck on simulation package"
	docker run --rm -v $(PWD)/backend:/src -w /src golang:1.22-alpine sh -c \
		"go install honnef.co/go/tools/cmd/staticcheck@latest && staticcheck ./internal/simulation/..."
