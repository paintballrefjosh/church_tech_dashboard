SHELL := /bin/bash
# scripts/compose.sh wraps docker compose and wires up DB_MODE (bundled
# CockroachDB vs an external YugabyteDB/CockroachDB) from .env.
COMPOSE := bash scripts/compose.sh
COMPOSE_PROD := bash scripts/compose.sh --prod
NODE_RUN := docker run --rm -v "$$PWD":/w -w /w -u $$(id -u):$$(id -g) -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache node:20-alpine sh -c
PNPM := npx -y pnpm@9.12.0

.PHONY: help check-ports init-env init-data up down restart logs ps psql migrate seed reset-admin reset-test-user disable-test-user build install typecheck lint test test-smoke test-e2e regression nuke db-backup db-restore db-backup-s3 db-list-s3 db-restore-s3 prod-up prod-down prod-logs prod-migrate prod-seed rebuild rebuild-all

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
	@mkdir -p data/cockroach-1 data/cockroach-2 data/cockroach-3 data/cockroach data/certs data/garage/data data/meili data/caddy data/caddy-config backups
	@# Meilisearch (uid 1001) needs a writable dir; chmod is simplest.
	@chmod 0777 data/meili 2>/dev/null || true
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

# SQL shell: the bundled Cockroach's own client, or a psql container on the
# stack network for an external database (psql talks to both engines).
psql:
	@if [ "$$(bash scripts/compose.sh --db-mode)" = bundled ]; then \
	  $(COMPOSE) exec cockroach-1 cockroach sql --insecure --database=church; \
	else \
	  docker run --rm -it --network church_internal postgres:16-alpine psql "$$(bash scripts/compose.sh --db-url)"; \
	fi

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
	@set +e; $(MAKE) test-smoke && $(MAKE) reset-test-user && $(MAKE) test-e2e; status=$$?; set -e; \
	  $(MAKE) disable-test-user; \
	  echo "regression done — bootstrap admin password unchanged; test user disabled"; \
	  exit $$status

nuke:
	$(COMPOSE) down -v
	rm -rf data
	@echo "All data destroyed. Run 'make up' to start fresh."

# Bundled CockroachDB only. `cockroach dump` was removed in v22, so this uses
# BACKUP into the node's local storage (nodelocal://1 = cockroach-1's
# cockroach-data/extern), streams that folder out as a .tgz, then deletes it
# from the store. The archive is a native Cockroach backup, not SQL.
CRDB_EXTERN := /cockroach/cockroach-data/extern

db-backup:
	@if [ "$$(bash scripts/compose.sh --db-mode)" = external ]; then \
	  echo "DB_MODE=external: back the database up with its own tooling (ysql_dump / cockroach BACKUP)."; exit 1; fi
	@mkdir -p backups
	@TS=crdb-$$(date +%Y%m%d-%H%M%S); \
	  $(COMPOSE) exec -T cockroach-1 cockroach sql --insecure \
	    -e "BACKUP DATABASE church INTO 'nodelocal://1/$$TS'" >/dev/null \
	  && $(COMPOSE) exec -T cockroach-1 tar -czf - -C $(CRDB_EXTERN) $$TS > backups/$$TS.tgz; \
	  status=$$?; \
	  $(COMPOSE) exec -T cockroach-1 rm -rf $(CRDB_EXTERN)/$$TS; \
	  if [ $$status -ne 0 ]; then rm -f backups/$$TS.tgz; echo "backup failed"; exit $$status; fi; \
	  echo "wrote backups/$$TS.tgz"

# The same through the object store (scripts/db-s3.sh), so a backup is not tied to
# one node's disk: any node can restore it. `make db-backup-s3`, `make db-restore-s3
# CONFIRM=yes`, `make db-list-s3`; add PROD=1 for the prod stack.
db-backup-s3:
	@bash scripts/db-s3.sh $(if $(PROD),--prod) backup
db-list-s3:
	@bash scripts/db-s3.sh $(if $(PROD),--prod) list
db-restore-s3:
	@bash scripts/db-s3.sh $(if $(PROD),--prod) restore $(if $(filter yes,$(CONFIRM)),--confirm)

# Replaces the live `church` database with the backup: stops api/web/monitor,
# restores into church_restoring, and only once that succeeded drops church and
# renames the copy into place (a failed restore leaves church untouched), then
# starts them again. Needs CONFIRM=yes.
db-restore:
	@if [ -z "$(FILE)" ]; then echo "usage: make db-restore FILE=./backups/crdb-YYYYMMDD-HHMMSS.tgz CONFIRM=yes"; exit 1; fi
	@if [ "$$(bash scripts/compose.sh --db-mode)" = external ]; then \
	  echo "DB_MODE=external: restore with the database's own tooling."; exit 1; fi
	@if [ "$(CONFIRM)" != yes ]; then \
	  echo "This DROPS the current church database and replaces it with $(FILE)."; \
	  echo "Re-run with CONFIRM=yes to go ahead."; exit 1; fi
	@DIR=$$(tar -tzf "$(FILE)" | head -n 1 | cut -d/ -f1); \
	  [ -n "$$DIR" ] || { echo "$(FILE) doesn't look like a db-backup archive"; exit 1; }; \
	  $(COMPOSE) exec -T cockroach-1 mkdir -p $(CRDB_EXTERN) \
	  && $(COMPOSE) exec -T cockroach-1 tar -xzf - -C $(CRDB_EXTERN) < "$(FILE)" \
	  && $(COMPOSE) stop api web monitor \
	  && $(COMPOSE) exec -T cockroach-1 cockroach sql --insecure \
	    -e "DROP DATABASE IF EXISTS church_restoring CASCADE" \
	    -e "RESTORE DATABASE church FROM LATEST IN 'nodelocal://1/$$DIR' WITH new_db_name = 'church_restoring'" \
	    -e "DROP DATABASE IF EXISTS church CASCADE" \
	    -e "ALTER DATABASE church_restoring RENAME TO church"; \
	  status=$$?; \
	  $(COMPOSE) exec -T cockroach-1 rm -rf $(CRDB_EXTERN)/$$DIR; \
	  $(COMPOSE) start api web monitor; \
	  if [ $$status -ne 0 ]; then echo "restore failed"; exit $$status; fi; \
	  echo "restored church from $(FILE)"

prod-up: init-env init-data check-ports
	@if [ "$$(bash scripts/compose.sh --prod --deploy-mode)" = cluster ]; then \
	  echo "DEPLOY_MODE=cluster: start this node with scripts/cluster.sh (see INSTALL.md, shape C):"; \
	  echo "  first time: start-data, init-db, garage-bootstrap, migrate, seed, then up"; \
	  echo "  afterwards: scripts/cluster.sh up"; \
	  exit 1; \
	fi
	$(COMPOSE_PROD) up -d --build

prod-down:
	$(COMPOSE_PROD) down

prod-migrate:
	$(COMPOSE_PROD) exec api node dist/scripts/migrate.js

prod-seed:
	$(COMPOSE_PROD) exec api node dist/scripts/seed.js

prod-logs:
	$(COMPOSE_PROD) logs -f --tail=200
