# Church Dashboard

A self-hosted, modular dashboard for a single church. One place for support tickets,
the wiki, notes, monitoring, printer status, network views, ProPresenter control,
Planning Center, volunteer checklists, and the rest.

> **Status:** Phases 0–2 are in place and Phase 3 is mostly there (search,
> @mentions, tags, activity, checklists, saved views). The AI/LLM/MCP module is
> the main thing still on the list. See [CLAUDE.md](./CLAUDE.md) § Roadmap.

## What's in here

| Module | Phase | Status |
|---|---|---|
| Auth (Google + Microsoft Entra + local + TOTP) | 0 | ready |
| External-account approval flow (volunteers) | 1 | ready |
| Users, groups, per-module tiered access, audit log | 0 | ready |
| Light / dark theme + PWA shell | 0 | ready |
| Reverse proxy on a single port | 0 | ready |
| Modular tile dashboard | 1 | ready |
| Helpdesk / tickets (+ SLAs) | 1 | ready |
| Wiki (markdown, attachments, ACLs) | 1 | ready |
| Notes (Keep-style) | 1 | ready |
| Notification centre + SMTP (per-category in-app / email) | 1 | ready |
| Monitoring (ICMP/TCP/HTTP + incidents) | 2 | ready |
| Printer (SNMP) status | 2 | ready |
| UniFi network views | 2 | ready |
| ProPresenter integration | 2 | ready |
| Planning Center integration | 2 | ready |
| Volunteer checklists | 3 | ready |
| Full-text search (wiki / notes / tickets) | 3 | ready |
| @mentions, tags, activity feed, saved views | 3 | ready |
| AI / LLM / MCP module | 3 | planned |

## Architecture in one paragraph

Next.js 15 frontend + NestJS backend + CockroachDB (multi-master, Postgres-wire) +
Redis + MinIO + Meilisearch, all behind Caddy on a single host port (default **:8100**,
HTTP only — terminate HTTPS upstream). Auth.js handles Google and Microsoft Entra SSO
plus local accounts with optional/required TOTP; OAuth providers are configured at
runtime in the database, not in env. Access control is group-based with per-module
tiers (`user` / `moderator` / `admin`) that resolve to the permission strings the API
guards on. Every mutating action lands in the `audit_log` table via a NestJS
interceptor. Realtime updates push over Socket.io with a Redis pub/sub adapter.

## Quick start

```bash
git clone <this repo>
cd church-dashboard
make up        # generates .env with a random AUTH_SECRET; creates ./data/ bind mounts
make migrate   # applies DB migrations
make seed      # seeds default groups + per-module access and the bootstrap admin (user "admin", password "admin")
open http://localhost:8100
```

Sign in with **admin / admin**. You'll be forced to set a new password on first login.
After that, all other settings (Google/Microsoft OAuth, SMTP, etc.) live in the database — edit
them at `/admin/settings` instead of touching files.

Persistent data is bind-mounted into `./data/<service>/` so backing up the whole stack is a
`tar -czf backup.tgz data/ .env` away. Full setup details and Google Workspace integration are in
[INSTALL.md](./INSTALL.md).

> **`AUTH_SECRET` is the one secret that matters.** Set in `.env` (shared identically by
> `web` and `api`), it (1) signs/encrypts the Auth.js session cookie, (2) lets the API
> validate that cookie on every request and WebSocket, (3) derives the web→api internal-call
> token, and (4) **encrypts secret settings — SMTP password, OAuth secrets — at rest in the
> DB**. `make up` generates a random one. Two consequences: **back up `.env` together with
> `data/`** (a data-only backup can't be decrypted), and **don't rotate it casually** —
> changing it logs everyone out and makes stored secrets unreadable, so you'd re-enter them
> at `/admin/settings`.

## Deployment

Only Caddy is exposed to the host. Everything else is on the internal compose network.
The upstream load balancer terminates TLS and forwards HTTP to host port **:8100**.

```bash
docker compose -f infra/docker-compose.prod.yml up -d --build
```

Prod compose runs a 3-node CockroachDB cluster and expects production env vars
(see [INSTALL.md](./INSTALL.md#production)). Outbound mail uses whatever SMTP server
you configure in `/admin/settings` (the same in dev and prod).

## Regression testing

After any change, run the regression suite. It boots nothing — it expects the stack to
be running — and exercises the live services and HTTP endpoints (smoke) plus the core
feature flows in a browser (Playwright e2e).

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
