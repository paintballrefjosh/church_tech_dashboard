SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml
COMPOSE_PROD := docker compose -f infra/docker-compose.prod.yml
NODE_RUN := docker run --rm -v "$$PWD":/w -w /w -u $$(id -u):$$(id -g) -e HOME=/tmp node:20-alpine sh -c

.PHONY: help up down restart logs ps psql migrate seed seed-credentials build install typecheck lint test test-smoke test-e2e regression nuke db-backup db-restore prod-up prod-down prod-logs

help:
	@echo "Common targets:"
	@echo "  make up           Start dev stack"
	@echo "  make down         Stop dev stack (keep data)"
	@echo "  make nuke         Stop + delete volumes (DESTROYS DATA)"
	@echo "  make logs         Tail all dev logs"
	@echo "  make migrate      Apply DB migrations"
	@echo "  make seed         Seed default roles + bootstrap admin"
	@echo "  make regression   Run smoke + e2e suite against running stack"
	@echo "  make prod-up      Start prod stack"

up:
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

seed-credentials:
	$(COMPOSE) exec api cat /tmp/bootstrap-credentials.txt 2>/dev/null || echo "No bootstrap credentials saved. Run 'make seed' first."

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

regression: test-smoke test-e2e

nuke:
	$(COMPOSE) down -v
	rm -rf data backups

db-backup:
	@mkdir -p backups
	@TS=$$(date +%Y%m%d-%H%M); \
	  $(COMPOSE) exec -T cockroach-1 cockroach dump church --insecure | gzip > backups/cockroach-$$TS.sql.gz; \
	  echo "wrote backups/cockroach-$$TS.sql.gz"

db-restore:
	@if [ -z "$(FILE)" ]; then echo "usage: make db-restore FILE=./backups/xxx.sql.gz"; exit 1; fi
	gunzip -c $(FILE) | $(COMPOSE) exec -T cockroach-1 cockroach sql --insecure --database=church

prod-up:
	$(COMPOSE_PROD) up -d --build

prod-down:
	$(COMPOSE_PROD) down

prod-logs:
	$(COMPOSE_PROD) logs -f --tail=200
