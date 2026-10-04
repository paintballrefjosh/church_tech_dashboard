# CLAUDE.md

Context file for Claude (or any AI assistant) working on this repo. Keep this current.

## What this project is

A web-based dashboard for a single church. Modular tile dashboard, helpdesk
(tickets + SLAs), wiki, notes, monitoring + incidents, printer (SNMP) status,
UniFi network views, ProPresenter control, Planning Center, volunteer checklists,
tags, @mentions, activity feed, full-text search, a notification centre, and
admin. Self-hosted via Docker Compose behind an upstream HTTPS load balancer.

**Tenancy:** single church only. Do **not** add `tenant_id` columns or multi-tenant
abstractions. If multi-tenancy is ever needed it will be a separate, explicit phase.

## Architecture

```
                                            ┌──────────────────────┐
                          host :8100  ──────►│  Caddy (proxy)       │
                          (HTTP only,        │  routes / → web      │
                          HTTPS upstream)    │  routes /api → api   │
                                            └─────┬──────────┬──────┘
                                                  │          │
                                          ┌───────▼───┐  ┌───▼────────┐
                                          │  web      │  │  api       │
                                          │  Next.js  │  │  NestJS    │
                                          │  Auth.js  │  │  Drizzle   │
                                          │  :3000    │  │  :3001 +WS │
                                          └─────┬─────┘  └─┬───┬──────┘
                                                │          │   │
                                       ┌────────▼──────────▼─┐ │
                                       │  CockroachDB        │ │
                                       │  (1 node dev,       │ │
                                       │   3 node prod)      │ │
                                       └─────────────────────┘ │
                                                               │
                       ┌─────────┐  ┌─────────────┐  ┌─────────▼────┐
                       │  redis  │  │  meilisearch│  │  minio (S3)  │
                       └─────────┘  └─────────────┘  └──────────────┘
                       (sessions,    (search across   (attachments,
                        WS pub/sub,   wiki/notes/      note images,
                        job queue)    tickets)         wiki uploads)
```

The `monitor` probe worker runs as its own service in the dev/prod stack. The
ProPresenter, UniFi, and Planning Center integrations are outbound HTTP/WS
clients to external systems (configured in the `settings` table), not local
services in compose.

## Tech stack (pinned)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + TS 5 | RSC where it helps; Tailwind for styles |
| Backend | NestJS 10 + Fastify adapter | WS via Socket.io, RBAC guard, audit interceptor |
| DB | CockroachDB v24 | Postgres-wire; **do not** use Postgres-only features (e.g. `LISTEN/NOTIFY`) |
| ORM | Drizzle ORM + drizzle-kit | Schema-as-code TS; migrations checked into `apps/api/migrations/` |
| Auth | Auth.js v5 (NextAuth) | Google + Microsoft Entra OAuth + Credentials (argon2id) + TOTP; providers configured in DB `settings`, not env |
| Realtime | Socket.io 4 + Redis adapter | Rooms per resource (`ticket:{id}`) and per user (`user:{id}`) |
| Search | Meilisearch v1 | Single `content` index, kind-discriminated; permission-filtered at query time (see ## Search) |
| File storage | MinIO (S3-compatible) | Behind API only, never exposed via proxy |
| Reverse proxy | Caddy 2 | Only ingress; serves :8100 |
| Monorepo | pnpm 9 + Turborepo | `pnpm -w` for workspace commands |

## Repo layout

```
apps/
  web/        Next.js — UI, Auth.js routes, theme, PWA
  api/        NestJS — REST + WS, access guards, audit, DB access
              (drizzle schema in src/db/schema/, migrations in apps/api/migrations/)
services/
  monitor/    ICMP/TCP/HTTP probe worker (its own compose service)
packages/
  shared/     Zod schemas, modules/permissions/settings catalogues, audit types
infra/
  docker-compose.yml         dev (single Cockroach node)
  docker-compose.prod.yml    prod (3-node Cockroach)
  caddy/Caddyfile            ingress config
tests/
  e2e/        Playwright suite (runs against the live compose stack)
  smoke/      API/HTTP regression suite (Node, runs against live stack)
```

## Access control: groups + module tiers

There is **no role model** in the live system anymore (it was replaced in
migrations 0022/0024). Access is granted as **(module, tier)** per **group**:

- A user belongs to 0+ **groups** (`groups` + `group_memberships`).
- Each group is granted a **tier** on each **module** it can touch
  (`group_module_access` → `(group_id, module_key, tier)`).
- Tiers are `user` < `moderator` < `admin`; higher tiers inherit lower ones. The
  `admin` module only has the `admin` tier.
- `loadUserById` in [apps/api/src/auth/auth.service.ts](apps/api/src/auth/auth.service.ts)
  resolves a user's groups → highest tier per module → a flat set of permission
  **strings** (e.g. `tickets:write:any`) via `permissionsFor()` in
  `packages/shared/src/modules.ts`. Route guards still check permission strings —
  but those strings are now *derived* from module tiers, not stored per role.
- The `admin` **group** is special-cased: top tier on every module + every
  permission, and locked from edit in the UI/API.

Modules are defined in `packages/shared/src/modules.ts`: `notes`, `tickets`,
`wiki`, `monitoring`, `printers`, `propresenter`, `planning_center`,
`checklists`, `admin`. Default per-group grants live in
`DEFAULT_GROUP_MODULE_ACCESS` and are applied by the seed.

The `monitoring` module is a single section covering tabbed views under
`/monitoring`: **Services** (uptime probes run by the `services/monitor` worker —
`http`/`tcp`/`icmp`/`dns`; per-kind config lives in the monitor's freeform
`options` blob, no migration to add a kind. **`tls` is in `MONITOR_KINDS` but the
worker has no probe for it**: a `tls` monitor reports `unknown kind` (down). The
worker fans incidents out to the monitoring recipients like infra alerts), **Infrastructure**
(`/monitoring/infra` — host/Docker/Proxmox; the per-host detail page charts
CPU/mem/disk plus load/temperature — persisted into rollups — and network/disk-IO,
which are raw-sample-only so they populate at the ≤2h range), **Network (UniFi)**
(`/monitoring/network`),
**Network (Cisco)** (`/monitoring/network-cisco` — the `cisco` module: an SSH
poller for Cisco IOS/NX-OS switches with config backups, drift, MAC/ARP/VLAN
caches; ported from the standalone `cisco-switch` app. Reads gate on
`monitors:read:any`, writes on `monitors:write:any`), and **IPAM**
(`/monitoring/ipam` — the `ipam` module: a lightweight IP-address manager. A
background scanner (`ipam/ipam.scanner.ts`, same self-rescheduling `setTimeout`
shape as the Cisco poller) sweeps managed subnets ICMP-first with a TCP-connect
fallback — ICMP is `spawn`ed `ping`, so the api container has `cap_add: NET_RAW`
in compose — and records live hosts in `ipam_hosts` with names from reverse
DNS / NetBIOS (nbstat) / the UniFi controller's client list (alias or DHCP
hostname) as each is toggled on. (Bonjour/mDNS was dropped: it is link-local
only, so an off-subnet scanner's queries are never answered — UniFi already
holds those friendly names, including phones/IoT.) Ranges are added
manually or discovered from Cisco SVI config lines + ARP and UniFi
`rest/networkconf` (`IpamService.discover`), each candidate labelled from its
source name (UniFi network name, or the matching switch's VLAN name from
`show vlan brief`/`cisco_vlan_db`) when adopted. Every scanner tick also calls
`IpamService.syncLabels()` — unconditionally, not gated by the scan-enable
toggle, since it's just a metadata read — to refresh that label from the
source system for any subnet still flagged `label_auto`; editing a label by
hand (`PATCH /api/ipam/subnets/:id`) clears that flag so a manual rename is
never overwritten. Scan knobs — enable, interval,
concurrency, timeout, DNS/NetBIOS/UniFi-name toggles, TCP ports — live in the
`monitoring` settings category; reads gate on `monitors:read:any`, writes on
`monitors:write:any`). The old
standalone `network` module was merged into `monitoring` (migration 0031); the
UniFi `unifi:read:any` / `unifi:admin` permissions are now granted by the
`monitoring` tier, and the UniFi controller settings live in the `monitoring`
settings category (`/admin/settings/monitoring`). The API endpoints stay at
`/api/v1/unifi/*` — only the module/UI grouping changed.

There is also a **UPS** tab (`/monitoring/ups` — the `ups` module: an SNMP poller
over UPS-MIB / RFC 1628, mirroring the `printers` module — `ups_devices` table, a
`setInterval` poller in `ups.service.ts`, per-device SNMP creds falling back to
`monitoring.ups_*` settings; battery %, runtime, load, in/out voltage. Reuses the
`monitoring` permissions like cisco/ipam — reads `monitors:read:any`, writes
`monitors:write:any`, no dedicated module/permission strings).

There is also a **DNS** tab (`/monitoring/dns` — the `dns` module: a client for a
Technitium DNS Server cluster running *outside* this stack, so port 53 never
touches compose). `dns/technitium.ts` calls the Technitium HTTP API with the token
as `Authorization: Bearer` (never in the URL); only the cluster **primary** is
configured (`dns.primary_url`, `dns.api_token`, `dns.verify_tls` in the
`monitoring` settings category) because it alone accepts zone edits and
aggregates cluster stats (`node=cluster`). Summary/tab badge (primary
unreachable = critical, a non-connected cluster node = degraded), cluster nodes,
query stats, zones and records, plus audited record create/edit/delete
(A/AAAA/CNAME/PTR/MX/TXT/SRV) on Primary zones. Technitium records have no id,
so writes address a record by zone + name + structured `data` and re-read it
first: that read is the audit "before", supplies the current TTL/disabled flag
(an update that omits them resets TTL to 3600 and re-enables the record), and
refuses (409) records whose comment carries `DNS_MANAGED_MARKER`. Same
`monitors:*` permissions as cisco/ipam/ups.

**IPAM→DNS sync** (`dns/dns.sync.ts`, `dns_*` settings, migration 0048): hosts
in subnets with `ipam_subnets.dns_sync` on get an A record in `dns.sync_zone`
(plus a PTR when a matching in-addr.arpa zone exists; missing reverse zones are
reported and created only on request). The name is `ipam_hosts.dns_name`
(override) → UniFi name → NetBIOS name, cleaned to one DNS label; **never** the
scanner's reverse-DNS `hostname`, which would read back the sync's own PTRs.
Collisions: an override wins, then the most recently seen host; others get
`-<last octet>`. All the diffing is the pure `computeSyncPlan` in
`dns/sync-plan.ts` (unit-tested in `apps/api/test/`); the preview, runs and tests
share it. Ownership is the `DNS_MANAGED_MARKER` comment on the Technitium
record, never the ledger: the sync only changes or removes marked records, and a
hand-made record at a wanted name is a conflict (the host's PTR is skipped too).
`dns_managed_records` is a ledger rebuilt each run for the UI; `dns_sync_runs`
is the audit trail for background runs (the interceptor never sees them).
Removals run after adds/updates because Technitium deletes the PTR pointing at
an A record when that A is deleted; a remove that finds nothing counts as done.
A run that would remove >20 records (or >25% of the managed set past 5) stops
unless forced. Triggers: end of each IPAM scanner pass and IPAM edits
(debounced), a 15-minute timer, and "Sync now"; background runs only while
`dns.sync_enabled` is on. One run at a time via an in-process guard (single API
process).

**DNS health** (`dns/dns.health.ts`): "Create health monitors" on the Overview
adds one `dns` uptime monitor per node (cluster node IPs, or typed in) that
resolves the TXT canary `_dashboard-canary.<zone>` through that node, so a dead
node or a secondary that stopped receiving zone transfers opens a normal
incident. The canary carries the managed marker so it can't be hand-edited.
`dns.alert_unreachable` adds a notification-only alert (kind
`dns.primary_unreachable`, like UniFi's, since the primary's API isn't a monitor
row) after 3 failed 60s polls of the primary, plus a recovery notice; silenced
by maintenance mode. The dashboard monitoring tile has a DNS row (nodes up/down).

**Maintenance mode:** the `monitoring.maintenance_mode` boolean setting silences
alert *notifications* across infra thresholds, service up/down, UniFi
device-offline, and Cisco switch alerts — incidents are still recorded, only the
in-app/email fan-out is paused. (UPS has no alert fan-out; IPAM none either.)
Each fan-out point reads the setting fresh (`SettingsService.get`). Presented as
an inverted "Enabled" switch (on = alerts fire, the default; off = maintenance)
right-aligned on the Monitoring tab row (`maintenance-control.tsx`, rendered
inside `MonitoringTabs`) via `GET`/`POST /api/v1/monitors/maintenance`, or from
`/admin/settings/monitoring`.

**UniFi device acks:** an offline UniFi device can be acknowledged
(`POST /api/v1/unifi/devices/:mac/ack`, gated on `monitors:write:any`) to
suppress it from the Network (UniFi) tab problem badge. Acks live in
`unifi_device_acks` (keyed by MAC) and cover only the *current* offline episode:
`UnifiService.reconcileAcks` runs on every controller read (`summary`/`snapshot`/
`devices`) and deletes the ack the moment the device is seen online again, so a
later re-offline counts (and alerts) afresh. `summary().devices.acked` carries
the count; the badge shows `offline - acked`. `DELETE .../ack` clears it
manually. Web sub-pages under `/monitoring` can dispatch the
`monitoring:health-refresh` window event (see `section-tabs.tsx`) after a
mutation to refresh the tab badges immediately instead of on their 20s poll.

Three groups ship by default: `admin` (everything), `support_engineer`
(helpdesk-focused), `user` (baseline; auto-joined by every newly provisioned
account). Wiki page ACLs and other per-resource controls reference **groups**.

**Legacy:** the `roles`, `permissions`, `role_permissions`, `user_roles`, and
`group_permissions` tables still exist (kept for migration safety) but are never
read; the old `apps/api/src/roles/` module was removed. Don't write code that
reads them — use `group_module_access`.

## Auth flow

Sign-in providers are configured at runtime in the `settings` table (toggles +
OAuth credentials), so they change without a redeploy:
- **Local credentials** (argon2id) — `auth.local.enabled`
- **Google** (OAuth/OIDC) — `auth.google.enabled` + `google.oauth.*`
- **Microsoft Entra ID** (OAuth/OIDC) — `auth.microsoft.enabled` + `microsoft.oauth.*`

1. User hits `/signin` (renders only the enabled providers)
2. Google / Microsoft OAuth, or local credentials (argon2id verify)
3. If the user has TOTP enabled, the credentials flow also requires a 6-digit code
4. On success, Auth.js issues a signed JWT session cookie
5. `web` calls `api` with the session cookie; `api` validates it with the shared
   `AUTH_SECRET` in `SessionGuard`
6. Service-to-service / script calls use `api_tokens` (bearer header), not sessions

`web` reads the provider config from the internal-only endpoint
`/api/v1/auth/providers/internal` (gated by an `X-Internal-Token` derived from
`AUTH_SECRET`, and 404'd by Caddy on the public proxy). A toggle can't be enabled
until its credentials are present — enforced by `TOGGLE_PREREQUISITES` in
`packages/shared/src/settings.ts` and the settings UI.

### TOTP / 2FA is optional, off by default

TOTP enrolment is **per-user** and **opt-in**. Two policy knobs in the settings
table can require it:

- `auth.require_totp_admin` — every member of the `admin` group must enrol.
- `auth.require_totp_all` — every signed-in user must enrol.

Both default to **off**. When on, the `SessionGuard` lets affected users
authenticate and read (GETs pass) but refuses all mutating requests until
they complete `/auth/totp/enroll` + `/auth/totp/confirm`. There is currently
**no separate recovery-codes flow** — if an admin enables `require_totp_admin`
and then loses their phone, another admin must flip it back off in
`/admin/settings`. Plan for recovery before flipping these on in prod.

There is no "admin role implicitly requires TOTP" in the code — earlier
versions of these docs claimed there was; that claim was aspirational, not
enforced. The two settings above are the only TOTP gates.

### Account gating & lifecycle

`SessionGuard` enforces these gates; each blocks everything but a narrow
allowlist until cleared (and each throws a **403**, not a 401 — the enforcement
calls run outside the cookie-decode try/catch so the 403 isn't swallowed):

- **`must_change_password`** — set on the bootstrap admin, on admin password
  resets, and optionally on admin-created users. Blocks all mutations except
  `POST /me/change-password`; the web force-routes to `/change-password`.
- **`approval_status = "pending"`** — an external OAuth account awaiting admin
  approval. Blocked from everything except `GET /me`; the web routes them to
  `/pending`.

**External-account approval (for volunteers):** when
`google.allow_external_with_approval` is on, Google accounts *outside*
`google.workspace_domain` may sign in but land `pending` with no
group/permissions until an admin approves them at `/admin/users` (Pending tab).
Workspace-domain accounts are auto-approved into the default `user` group. The
decision lives in `usersService.provisionOAuthUser`. (Microsoft accounts don't
use the pending gate.)

**Soft delete:** `DELETE /users/:id` tombstones the row (`deleted_at`,
`is_active=false`) but keeps authored content + audit attribution;
`POST /users/:id/restore` reverses it; `POST /users/:id/hard-delete` (SITE_ADMIN,
only after soft-delete) permanently removes the row and frees the email. The admin
users page has Active / Pending / Disabled / Deleted tabs and an `external` badge
for OAuth-linked accounts.

## Audit log

Every mutating action (POST/PUT/PATCH/DELETE that hits an audited route) writes a row to
`audit_log` via a NestJS interceptor. Schema: `(id, actor_user_id, action,
resource_type, resource_id, before, after, ip, user_agent, ts)`. Do **not** bypass the
interceptor; if you find yourself needing to, fix the interceptor instead.

## Search

Global search ("Search everything…" in the top bar + the Cmd/Ctrl-K palette) is
one Meilisearch index, `content`, holding every searchable kind with a `kind`
discriminator — **not** an index per resource type. Filterable attributes
(`kind`, `ownerUserId`, `visibility`, `aclGroupIds`, `tagIds`) let one query
scope results per request; searchable attributes are `title` + `body`. Every doc
carries an explicit `url` for deep-linking (set at index time), so kinds whose
link target differs from their `resourceId` (an infra entity → its parent host,
a Cisco MAC → the lookup page) route correctly without the frontend hard-coding
cases. The web side shares one `apps/web/src/lib/search-kinds.ts` for
labels/icons/colours/routing across both search surfaces.

Indexed kinds (see `SearchKind` in
[apps/api/src/search/search.service.ts](apps/api/src/search/search.service.ts)):

- **Content:** `ticket`, `note`, `wiki` — upserted incrementally by their
  services on create/update.
- **Monitoring (DB-backed):** `monitor`, `infra_target`, `infra_entity`,
  `cisco_switch`, `cisco_port`, `cisco_mac`, `cisco_arp`, `cisco_vlan`,
  `ipam_subnet`, `ipam_host`.
  Reconciled by `syncMonitoringDbSources()` — a **scoped** clear-and-rebuild that
  deletes only the monitoring kinds by filter then re-adds them, leaving
  content/UniFi docs untouched. Runs on startup, on a timer
  (`SEARCH_MONITORING_SYNC_MS`, default 120s, so poller churn is picked up
  without a manual reindex), and from the admin Reindex button.
- **DNS (live, in Technitium):** `dns_record`. `DnsSearchIndexer` replaces the
  whole kind from a full read of every zone on a timer (`DNS_SEARCH_SYNC_MS`,
  default 300s) and shortly after each dashboard write; an unconfigured server
  clears it, an unreachable one keeps the last set. Kept out of
  `MONITORING_KINDS` (whose sync rebuilds from the DB) but gated the same way.
- **UniFi (live, not in the DB):** `unifi_device`, `unifi_client`. Pushed by the
  `UnifiPoller` via `syncUnifi()` on each poll; the poller also self-refreshes on
  an idle cadence (`UNIFI_SEARCH_SYNC_MS`, default 300s) so devices/clients stay
  searchable even with nobody viewing the Network page and alerting off.

**Permission gating happens in the query filter, never at index time** (so a
permission change takes effect immediately): monitoring kinds require
`monitors:read:any` (as does `dns_record`), UniFi kinds require `unifi:read:any`, tickets/wiki apply
their own read scoping. A user without a permission simply never gets those
kinds in the filter — nothing leaks through the index. When adding a new
searchable resource: add the `SearchKind`, a doc builder (with `url`), the query
gate, and an entry in `search-kinds.ts`.

## Conventions

- **Type-safe everywhere.** No `any` in committed code. Use Zod schemas from
  `packages/shared` for request/response validation on both sides.
- **No Postgres-only SQL.** Cockroach is wire-compatible but lacks `LISTEN/NOTIFY`,
  certain `pg_catalog` introspection, etc. Stick to portable SQL or use Drizzle helpers.
- **No `tenant_id`.** Single-tenant only.
- **Church-specific modules stay deferred.** Bespoke volunteer scheduling, kids
  check-in, and service planning are out of scope (decided 2026-05-25). The
  read-only Planning Center integration and the generic per-event checklists are
  the deliberate exceptions already shipped — don't add more church-domain
  features (or "in case we need them" hooks) without an explicit ask.
- **HTTPS is upstream.** Inside this stack everything is HTTP. Do not set `Secure`-only
  cookies or HSTS headers from this app — that is the load balancer's job. Cookies must
  still be `HttpOnly` and `SameSite=Lax`.
- **Single port 8100.** Caddy is the only thing bound to a host port. Every other
  service is internal to the compose network.
- **No emoji in code.** Per repo conventions.

## Common commands

All commands assume you're at the repo root.

```bash
# dev stack (Cockroach single-node). No bundled mail sink — configure SMTP in
# /admin/settings (or leave blank to disable email).
pnpm dev:up               # docker compose -f infra/docker-compose.yml up -d --build
pnpm dev:down             # stop + remove
pnpm dev:logs             # tail all services
pnpm dev:psql             # cockroach sql shell

# migrations
pnpm db:generate          # drizzle-kit generate (after editing schema TS)
pnpm db:migrate           # apply pending migrations
pnpm db:seed              # bootstrap admin + default groups & per-module access

# tests
pnpm test                 # unit tests (vitest)
pnpm test:smoke           # API/HTTP smoke tests against running stack
pnpm test:e2e             # Playwright e2e against running stack
pnpm regression           # smoke + e2e (used by CI and post-build verification)

# typecheck / lint
pnpm typecheck
pnpm lint
```

If `pnpm` is not installed on the host, every command above has a docker-only
equivalent — see [INSTALL.md](./INSTALL.md).

### Fast iteration after code changes

`make rebuild` is the preferred command to apply a code change to the running
stack. It diffs file mtimes against the `.last-rebuild` marker and only invokes
`--build` for services whose source actually changed (api, web, or both via a
`packages/shared/` edit). It also runs migrations only when there's a new SQL
file since `.last-migrate`. Both markers are gitignored.

Use `make rebuild-all` if you want to force a full rebuild of both services.
Avoid `docker compose -f infra/docker-compose.yml up -d --build api web` —
that wastes 5–15 s per build verifying the cache for the service that didn't
change. `make rebuild` does the right thing in all cases.

## Roadmap / status

- **Phase 0 — done** — auth, access control, audit log, theme shell, compose stack, regression suite
- **Phase 1 — done** — helpdesk/tickets (+SLAs), notes, wiki (+attachments/ACLs), modular dashboard tiles, notification centre + SMTP (per-category in-app/email)
- **Phase 2 — done** — monitoring (ICMP/TCP/HTTP) + incidents, UniFi views, printer (SNMP) status, ProPresenter adapter, Planning Center
- **Phase 3 — mostly done** — Meilisearch across wiki/notes/tickets **and all monitoring data points** (monitors, infra, UniFi devices/clients, Cisco switches/ports/MAC/ARP/VLAN — see ## Search), @mentions, tags, activity feed, saved views, checklists. **Still open: the AI/LLM/MCP module.**
- **Phase 4 — deferred** — bespoke church-specific modules. Do not start without an explicit ask.

**Deferred: infra threshold actions.** `InfraThresholdRule` (`packages/shared/src/schemas/infra.ts`)
currently only alerts — a sustained breach opens/resolves a `monitor_incident` and fans out
notifications, nothing more. Executing something when a rule breaches (run a command on the
host, reboot it) was discussed 2026-09-24 and deliberately deferred; this stays monitoring-only
for now. If revisited, two shapes were considered:
- **In-app action**: extend `InfraThresholdRule` with an optional action, fired once on the
  open-transition in `evaluateThresholds` (`apps/api/src/infra/infra-collector.ts`) — not on every
  poll while still breaching. Host commands would reuse `sshExec`. Needs its own audit trail (the
  audit interceptor only covers HTTP-triggered mutations, not poller-triggered ones) and a cooldown
  independent of `forSec` so a flapping metric can't refire it repeatedly.
- **Webhook out**: fire a webhook on breach and let an external automation tool (with its own
  approval/safety story) do the actual host mutation — keeps risky command execution out of this
  app entirely.
No decision was made between the two; revisit only on an explicit ask.

## Public origin / hostname handling

The app **does not bake any hostname into env or code**. It works at every URL
you can reach it on — `localhost:8100`, a LAN IP, `docker01.example.com:8100`,
behind an HTTPS LB — without any per-deployment config.

How it works end-to-end:
- Caddy listens on `:8100` and reverse-proxies to the upstream containers with
  `header_up Host {host}`, so `web` and `api` see the original `Host` header
  from the user's browser.
- Next.js standalone is the gotcha: it sets `req.url` from `HOSTNAME:PORT`
  (`0.0.0.0:3000`), not from the request's `Host` header. Auth.js builds OAuth
  callback URLs, sign-in redirects, and cookie domains from `req.url`, which
  would leak the bind address out to the browser and break every sign-in.
- The wrapper `withPublicOriginRewrite` in [apps/web/src/lib/auth.ts](apps/web/src/lib/auth.ts)
  intercepts every `/api/auth/*` request, rewrites `req.url` using
  `X-Forwarded-Host` (set by Caddy from the original Host) + `X-Forwarded-Proto`,
  and only then hands off to Auth.js. Result: the redirect/cookie/callback URL
  always matches the host the user actually typed.
- `AUTH_URL` and `APP_URL` are **intentionally unset** in `.env.example`. Setting
  them would override the dynamic detection and re-introduce the original bug.
  Only override if a proxy strips/rewrites both `Host` AND `X-Forwarded-Host`.

If you ever change the proxy or the way the Next standalone server starts:
re-test sign-in from **at least two different hostnames** (e.g. localhost and a
non-localhost domain) before merging. The smoke suite covers the localhost case;
the wrapper itself is non-trivial to unit-test, but the symptom — being
redirected to `http://0.0.0.0:3000/` — is obvious in the browser address bar.

## Host ports

Only one port on the docker host belongs to a real user: `EXTERNAL_PORT` (default
`8100`) for Caddy. The dev compose also exposes `COCKROACH_UI_PORT` (8180) as a
convenience. Both are env-overridable.

`scripts/check-ports.sh` runs automatically as part of `make up` (and `make prod-up`).
It distinguishes three states per port: free, held by one of our own containers
(re-up is safe), or taken by something else (abort with a suggested free port + env
var to set). Never bypass this check — port collisions surface late and confusingly.

Internal container ports (Next.js `:3000`, NestJS `:3001`) are NOT bound on the host;
they live on the `church_internal` bridge. Do not add `ports:` entries for them in
compose — that would defeat the single-ingress design.

## Operational defaults

- **Default admin:** seed creates user `admin` with password `admin` (stored as
  `admin@local`) and `must_change_password=true`. The first sign-in is force-routed to
  `/change-password`. `make reset-admin` restores this state — **only** if the operator
  explicitly asks. **Automated tests never touch the admin user's password.**
- **Regression test user:** smoke + e2e tests sign in as `regression-test@local`
  (created/refreshed by `make reset-test-user`, which is the first step of
  `make regression`). The bootstrap admin's credentials are immutable from the
  test suite's perspective — verified by setting a real admin password and
  running the full suite; admin password is preserved end-to-end.
- **Configuration:** anything an operator might want to change at runtime (Google OAuth
  client, SMTP, site name, etc.) lives in the `settings` table and is editable at
  `/admin/settings`. Only true bootstrap values (DB URL, `AUTH_SECRET`, `APP_URL`,
  Redis URL) stay in `.env`. `KNOWN_SETTINGS` in `packages/shared/src/settings.ts`
  is the catalogue.
- **Volumes:** all stateful services bind-mount into `./data/<service>/` at the repo
  root. Backup = `tar -czf data/`. `make init-data` creates the dirs with the right
  perms (Redis and Meilisearch need world-writable).

## Things to never do

- Add `tenant_id` columns
- Bypass the audit interceptor
- Set HTTPS/HSTS/TLS config inside the app (it's offloaded upstream)
- Expose any service besides Caddy to the host
- Hard-code role/group names in business logic (guard on permission strings derived from module tiers), or read the legacy `roles`/`permissions`/`role_permissions`/`group_permissions` tables
- Use Postgres-only features (Cockroach compatibility)
- Add Phase 4 church-specific modules without an explicit user ask
- Commit emojis in code or generated files
- Re-introduce env-based config for things in `KNOWN_SETTINGS` — they belong in the DB
