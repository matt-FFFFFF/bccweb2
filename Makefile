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
        docker-up docker-down clean

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
	npm run test --workspaces --if-present

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

# ─── Clean ────────────────────────────────────────────────────────────────────

clean:
	rm -rf apps/api/dist apps/web/dist packages/types/dist packages/scoring/dist
	rm -f packages/types/tsconfig.tsbuildinfo packages/scoring/tsconfig.tsbuildinfo
