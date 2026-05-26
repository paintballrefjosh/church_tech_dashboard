SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml
COMPOSE_PROD := docker compose -f infra/docker-compose.prod.yml
NODE_RUN := docker run --rm -v "$$PWD":/w -w /w -u $$(id -u):$$(id -g) -e HOME=/tmp node:20-alpine sh -c

.PHONY: help init-env init-data up down restart logs ps psql migrate seed reset-admin build install typecheck lint test test-smoke test-e2e regression nuke db-backup db-restore prod-up prod-down prod-logs

help:
	@echo "Common targets:"
	@echo "  make init-env     Generate .env from .env.example with a random AUTH_SECRET"
	@echo "  make init-data    Create ./data/* dirs for bind-mount volumes"
	@echo "  make up           Start dev stack (runs init-env + init-data first)"
	@echo "  make down         Stop dev stack (keep data)"
	@echo "  make nuke         Stop + delete ./data/* (DESTROYS DATA)"
	@echo "  make logs         Tail all dev logs"
	@echo "  make migrate      Apply DB migrations"
	@echo "  make seed         Seed default roles + bootstrap admin"
	@echo "  make regression   Run smoke + e2e suite against running stack"
	@echo "  make prod-up      Start prod stack"

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

up: init-env init-data
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

seed:
	$(COMPOSE) exec api node dist/scripts/seed.js

reset-admin:
	$(COMPOSE) exec api node dist/scripts/reset-admin.js

install:
	$(NODE_RUN) 'corepack enable && pnpm install --frozen-lockfile || pnpm install'

build:
	$(NODE_RUN) 'corepack enable && pnpm build'

typecheck:
	$(NODE_RUN) 'corepack enable && pnpm typecheck'

lint:
	$(NODE_RUN) 'corepack enable && pnpm lint'

test:
	$(NODE_RUN) 'corepack enable && pnpm test'

test-smoke:
	$(NODE_RUN) 'corepack enable && pnpm test:smoke'

test-e2e:
	$(NODE_RUN) 'corepack enable && pnpm test:e2e'

regression: reset-admin test-smoke test-e2e

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

prod-up: init-env init-data
	$(COMPOSE_PROD) up -d --build

prod-down:
	$(COMPOSE_PROD) down

prod-logs:
	$(COMPOSE_PROD) logs -f --tail=200
