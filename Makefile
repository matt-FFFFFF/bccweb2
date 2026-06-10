# ─── bccweb2 Makefile ─────────────────────────────────────────────────────────
#
# Usage:
#   make              # install + build everything
#   make build        # build all packages in dependency order
#   make build-types  # build shared types package
#   make build-scoring# build scoring package
#   make build-api    # build Azure Functions API
#   make build-web    # build React SPA
#   make typecheck    # typecheck all workspaces
#   make test         # run all tests
#   make dev          # start local dev stack (Docker + func + vite)
#   make dev-api      # start Azure Functions locally (requires Azurite running)
#   make dev-web      # start Vite dev server
#   make docker-up    # start Azurite + API + Web via Docker Compose
#   make docker-down  # stop Docker Compose stack
#   make clean        # remove all dist/ directories

.PHONY: all install build build-types build-scoring build-api build-web \
        typecheck test dev dev-api dev-web \
        docker-up docker-down clean \
        seed seed-rounds wipe-fixtures \
        loadtest-prepare loadtest-register loadtest-transition loadtest-sign loadtest-cleanup loadtest

# ─── Default ──────────────────────────────────────────────────────────────────

all: install build

# ─── Install ──────────────────────────────────────────────────────────────────

install:
	npm install

# ─── Build ────────────────────────────────────────────────────────────────────

# Full build in dependency order: shared packages first, then apps.
build: build-types build-scoring build-api build-web

build-types:
	npm run build --workspace=packages/types

build-scoring: build-types
	npm run build --workspace=packages/scoring

build-api: build-types build-scoring
	npm run build --workspace=apps/api

build-web: build-types
	npm run build --workspace=apps/web

# ─── Typecheck ────────────────────────────────────────────────────────────────

typecheck:
	npm run typecheck --workspaces --if-present

# ─── Test ─────────────────────────────────────────────────────────────────────

test:
	npx vitest run

# ─── Dev ──────────────────────────────────────────────────────────────────────

# Start the full local dev stack via Docker Compose (Azurite + API + Web).
dev: docker-up

# Start the Azure Functions host locally (Azurite must already be running).
dev-api: build-types build-scoring build-api
	npm run start --workspace=apps/api

# Start the Vite dev server (proxies /api → :7071, /blob → Azurite :10000).
dev-web:
	npm run dev --workspace=apps/web

# ─── Docker ───────────────────────────────────────────────────────────────────

docker-up:
	docker compose up --build

docker-down:
	docker compose down

# ─── Fixtures and load test ───────────────────────────────────────────────────
# seed              — seed 500 pilots / 50 clubs / 100 club-teams + season / sites / config
# seed-rounds       — seed 4 dev-browsing rounds (Proposed/Confirmed/BriefComplete/Locked)
# wipe-fixtures     — surgical wipe of all fixture entities by manifest
# loadtest-prepare  — create load-test round + 50 teams + confirm (writes tests/load/.prepared-round.json)
# loadtest-register — k6 register-self phase (500 VUs); logs in .omo/evidence/k6-logs/
# loadtest-transition — POST brief-complete on the prepared round
# loadtest-sign     — k6 sign phase; logs in .omo/evidence/k6-logs/
# loadtest-cleanup  — delete load-test round + signatures, keep fixtures
# loadtest          — chains prepare → register → transition → sign → cleanup
# All loadtest-* targets honour BCC_API_BASE_URL (default http://localhost:7071)
# and ADMIN_PASSWORD env vars for dual local/Azure operation.

seed:
	node scripts/seed-fixtures.mjs

seed-rounds:
	node scripts/seed-rounds.mjs

wipe-fixtures:
	node scripts/wipe-fixtures.mjs

loadtest-prepare:
	node scripts/prepare-loadtest.mjs

loadtest-register:
	@mkdir -p $(CURDIR)/.omo/evidence/k6-logs
	cd tests/load && k6 run --env PHASE=register sign-to-fly.js | tee $(CURDIR)/.omo/evidence/k6-logs/register-$$(date +%s).log

loadtest-transition:
	node scripts/transition-loadtest.mjs

loadtest-sign:
	@mkdir -p $(CURDIR)/.omo/evidence/k6-logs
	cd tests/load && k6 run --env PHASE=sign sign-to-fly.js | tee $(CURDIR)/.omo/evidence/k6-logs/sign-$$(date +%s).log

loadtest-cleanup:
	node scripts/cleanup-loadtest.mjs

# Make runs targets in dependency order; failure of any step short-circuits.
loadtest: loadtest-prepare loadtest-register loadtest-transition loadtest-sign loadtest-cleanup
	@echo "[loadtest] full pipeline complete"

# ─── Clean ────────────────────────────────────────────────────────────────────

clean:
	rm -rf apps/api/dist apps/web/dist packages/types/dist packages/scoring/dist
	rm -f packages/types/tsconfig.tsbuildinfo packages/scoring/tsconfig.tsbuildinfo
