SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml
COMPOSE_PROD := docker compose -f infra/docker-compose.prod.yml
NODE_RUN := docker run --rm -v "$$PWD":/w -w /w -u $$(id -u):$$(id -g) -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache node:20-alpine sh -c
PNPM := npx -y pnpm@9.12.0

.PHONY: help check-ports init-env init-data up down restart logs ps psql migrate seed reset-admin reset-test-user disable-test-user build install typecheck lint test test-smoke test-e2e regression nuke db-backup db-restore prod-up prod-down prod-logs rebuild rebuild-all

help:
	@echo "Common targets:"
	@echo "  make init-env         Generate .env from .env.example with a random AUTH_SECRET"
	@echo "  make init-data        Create ./data/* dirs for bind-mount volumes"
	@echo "  make check-ports      Confirm host-bound ports are free (auto-run by 'up')"
	@echo "  make up               Start dev stack (runs init-env + init-data + check-ports first)"
	@echo "  make down             Stop dev stack (keep data)"
	@echo "  make nuke             Stop + delete ./data/* (DESTROYS DATA)"
	@echo "  make logs             Tail all dev logs"
	@echo "  make migrate          Apply DB migrations"
	@echo "  make seed             Seed default roles + bootstrap admin"
	@echo "  make reset-admin      Force the bootstrap admin back to admin/admin (manual only)"
	@echo "  make reset-test-user  Force the regression test user back to default state"
	@echo "  make disable-test-user Disable the regression test user (post-test teardown)"
	@echo "  make regression       Run smoke + e2e suite (does NOT touch bootstrap admin)"
	@echo "  make prod-up          Start prod stack"

init-env:
	@if [ ! -f .env ]; then \
	  cp .env.example .env; \
	  if command -v openssl >/dev/null 2>&1; then \
	    SECRET=$$(openssl rand -hex 32); \
	  else \
	    SECRET=$$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'); \
	  fi; \
	  sed -i "s|AUTH_SECRET=replace-me-with-openssl-rand-hex-32|AUTH_SECRET=$$SECRET|" .env; \
	  echo "Created .env with a generated AUTH_SECRET. Review the file before going to production."; \
	else \
	  echo ".env already exists — leaving it alone."; \
	fi

init-data:
	@mkdir -p data/cockroach-1 data/cockroach-2 data/cockroach-3 data/redis data/minio data/meili data/caddy data/caddy-config backups
	@# Redis (uid 999) and Meilisearch (uid 1001) need writable dirs; chmod is simplest.
	@chmod 0777 data/redis data/meili 2>/dev/null || true
	@echo "data/ ready (bind-mount targets created)"

check-ports:
	@bash scripts/check-ports.sh

up: init-env init-data check-ports
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

psql:
	$(COMPOSE) exec cockroach-1 cockroach sql --insecure --database=church

migrate:
	$(COMPOSE) exec api node dist/scripts/migrate.js

# Selective rebuild for the dev iteration loop: only rebuilds api/web if their
# source actually changed since the last invocation, then applies migrations
# only if there are new SQL files. Replaces the slower pattern of unconditionally
# running `docker compose up -d --build api web` after every code change.
rebuild:
	@bash scripts/rebuild.sh

rebuild-all:
	@bash scripts/rebuild.sh --all

seed:
	$(COMPOSE) exec api node dist/scripts/seed.js

reset-admin:
	$(COMPOSE) exec api node dist/scripts/reset-admin.js

# Used by the regression suite. Creates/refreshes a dedicated test user
# (regression-test@local) with admin role and a known default password.
# The bootstrap admin user is NOT touched.
reset-test-user:
	$(COMPOSE) exec api node dist/scripts/reset-test-user.js

# Teardown counterpart: disables the regression test user once testing is done
# so the known-password admin account never lingers active (sign-in locked +
# dropped from notification recipients). reset-test-user re-enables it next run.
disable-test-user:
	$(COMPOSE) exec api node dist/scripts/disable-test-user.js

install:
	$(NODE_RUN) '$(PNPM) install --frozen-lockfile || $(PNPM) install'

build:
	$(NODE_RUN) '$(PNPM) build'

typecheck:
	$(NODE_RUN) '$(PNPM) typecheck'

lint:
	$(NODE_RUN) '$(PNPM) lint'

test:
	$(NODE_RUN) '$(PNPM) test'

# Smoke tests are a single Node script — no pnpm needed. Host networking lets
# the script reach the Caddy proxy at http://localhost:$(EXTERNAL_PORT).
test-smoke:
	docker run --rm --network=host -v "$$PWD":/w -w /w -u $$(id -u):$$(id -g) \
	  -e HOME=/tmp -e BASE=http://localhost:$${EXTERNAL_PORT:-8100} \
	  node:20-alpine node tests/smoke/run.mjs

# E2E uses the official Playwright image (browsers pre-installed) on host
# networking so it can reach the stack at http://localhost:$(EXTERNAL_PORT).
test-e2e:
	docker run --rm --network=host --ipc=host -v "$$PWD":/w -w /w/tests/e2e \
	  -u $$(id -u):$$(id -g) -e HOME=/tmp -e BASE=http://localhost:$${EXTERNAL_PORT:-8100} \
	  mcr.microsoft.com/playwright:v1.48.0-jammy npx playwright test --reporter=line

# regression uses a dedicated test user (regression-test@local) — the bootstrap
# admin's credentials are NEVER modified by tests. reset-test-user runs before
# the suite so the test user starts in a known default state.
regression:
	@$(MAKE) reset-test-user
	@set +e; $(MAKE) test-smoke && $(MAKE) test-e2e; status=$$?; set -e; \
	  $(MAKE) disable-test-user; \
	  echo "regression done — bootstrap admin password unchanged; test user disabled"; \
	  exit $$status

nuke:
	$(COMPOSE) down -v
	rm -rf data
	@echo "All data destroyed. Run 'make up' to start fresh."

db-backup:
	@mkdir -p backups
	@TS=$$(date +%Y%m%d-%H%M); \
	  $(COMPOSE) exec -T cockroach-1 cockroach dump church --insecure | gzip > backups/cockroach-$$TS.sql.gz; \
	  echo "wrote backups/cockroach-$$TS.sql.gz"

db-restore:
	@if [ -z "$(FILE)" ]; then echo "usage: make db-restore FILE=./backups/xxx.sql.gz"; exit 1; fi
	gunzip -c $(FILE) | $(COMPOSE) exec -T cockroach-1 cockroach sql --insecure --database=church

prod-up: init-env init-data check-ports
	$(COMPOSE_PROD) up -d --build

prod-down:
	$(COMPOSE_PROD) down

prod-logs:
	$(COMPOSE_PROD) logs -f --tail=200
