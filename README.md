# Church Dashboard

A self-hosted, modular dashboard for a single church. One place for the calendar,
support tickets, wiki, notes, ProPresenter control, monitoring, and the rest.

> **Status:** Phase 0 (foundations). Auth, RBAC, audit log, theme shell, and the
> Docker Compose stack are in place. Helpdesk / wiki / notes / monitoring / AI land in
> Phases 1–3. See [CLAUDE.md](./CLAUDE.md) for the full roadmap.

## What's in here

| Module | Phase | Status |
|---|---|---|
| Auth (Google Workspace + local + TOTP) | 0 | ready |
| Users, groups, roles, permissions, audit log | 0 | ready |
| Light / dark theme + PWA shell | 0 | ready |
| Reverse proxy on a single port | 0 | ready |
| Modular tile dashboard | 1 | planned |
| Helpdesk / tickets | 1 | planned |
| Wiki (markdown, attachments, ACLs) | 1 | planned |
| Notes (Keep-style) | 1 | planned |
| Notification center + SMTP | 1 | planned |
| Monitoring (ICMP/TCP/HTTP + incidents) | 2 | planned |
| UniFi integration | 2 | planned |
| ProPresenter integration | 2 | planned |
| AI / LLM / MCP module | 3 | planned |
| Full-text search (wiki / notes / tickets) | 3 | planned |

## Architecture in one paragraph

Next.js 15 frontend + NestJS backend + CockroachDB (multi-master, Postgres-wire) +
Redis + MinIO + Meilisearch, all behind Caddy on a single host port (default **:8100**,
HTTP only — terminate HTTPS upstream). Auth.js handles Google Workspace SSO and local
accounts with optional/required TOTP. RBAC is permission-string based (not role-name
based) and every mutating action lands in the `audit_log` table via a NestJS
interceptor. Realtime updates are pushed over Socket.io with a Redis pub/sub adapter.

## Quick start

```bash
git clone <this repo>
cd church-dashboard
cp .env.example .env       # edit AUTH_SECRET and Google OAuth credentials
make up                    # or: docker compose -f infra/docker-compose.yml up -d --build
make seed                  # creates default roles/permissions and bootstrap admin user
open http://localhost:8100
```

Full instructions, including Google Workspace setup, in [INSTALL.md](./INSTALL.md).

## Deployment

Only Caddy is exposed to the host. Everything else is on the internal compose network.
The upstream load balancer terminates TLS and forwards HTTP to host port **:8100**.

```bash
docker compose -f infra/docker-compose.prod.yml up -d --build
```

Prod compose runs a 3-node CockroachDB cluster, drops MailHog (uses real SMTP), and
expects production env vars (see [INSTALL.md](./INSTALL.md#production)).

## Regression testing

After any change to Phase 0, run the regression suite. It boots nothing — it expects
the stack to be running — and exercises every Phase 0 service and endpoint.

```bash
make regression
# equivalent: pnpm regression
```

## Project docs

- [CLAUDE.md](./CLAUDE.md) — architecture, conventions, "things to never do"
- [INSTALL.md](./INSTALL.md) — full setup, including Google Workspace
- Roadmap: see CLAUDE.md § Roadmap

## License

To be decided. Default for now: no public redistribution; private/internal use only.
