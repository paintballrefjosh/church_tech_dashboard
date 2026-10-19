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
                                       │  CockroachDB or     │ │
                                       │  YugabyteDB (see    │ │
                                       │  ## Database)       │ │
                                       └─────────────────────┘ │
                                                               │
                                      ┌─────────────┐  ┌──────────────┐
                                      │  meilisearch│  │ garage (S3)  │
                                      └─────────────┘  └──────────────┘
                                       (search across   (attachments,
                                        wiki/notes/      note images,
                                        tickets)         wiki uploads)

  No Redis: realtime fan-out between nodes, the mail queue, cache
  invalidation and the strict rate limits live in the database (see
  ## Cluster coordination).
```

The `monitor` probe worker runs as its own service in the dev/prod stack (it is
the only thing that probes uptime monitors; prod lacked it until 2026-10-03). The
ProPresenter, UniFi, and Planning Center integrations are outbound HTTP/WS
clients to external systems (configured in the `settings` table), not local
services in compose.

## Tech stack (pinned)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + TS 5 | RSC where it helps; Tailwind for styles |
| Backend | NestJS 10 + Fastify adapter | WS via Socket.io, RBAC guard, audit interceptor |
| DB | CockroachDB v24 or YugabyteDB YSQL (2024.2+) | Postgres wire; SQL must run on both (see ## Database) |
| ORM | Drizzle ORM + drizzle-kit | Schema-as-code TS; migrations checked into `apps/api/migrations/` |
| Auth | Auth.js v5 (NextAuth) | Google + Microsoft Entra OAuth + Credentials (argon2id) + TOTP; providers configured in DB `settings`, not env |
| Realtime | Socket.io 4 (in-process adapter) + `ClusterBus` over the DB between nodes | Rooms per resource (`ticket:{id}`) and per user (`user:{id}`) |
| Search | Meilisearch v1 | Single `content` index, kind-discriminated; permission-filtered at query time (see ## Search) |
| File storage | Garage (S3-compatible), or any external S3 store | Behind API only, never exposed via proxy. Was MinIO until its images were withdrawn from the registries (2026-10-04). |
| Reverse proxy | Caddy 2 | Only ingress; serves :8100 |
| Monorepo | pnpm 9 + Turborepo | `pnpm -w` for workspace commands |

## Repo layout

```
apps/
  web/        Next.js — UI, Auth.js routes, theme, PWA
  api/        NestJS — REST + WS, access guards, audit, DB access
              (drizzle schema in src/db/schema/, migrations in apps/api/migrations/;
              backups and restores in src/backup/)
services/
  monitor/    ICMP/TCP/HTTP probe worker (its own compose service)
packages/
  shared/     Zod schemas, modules/permissions/settings catalogues, audit types
install.sh                   guided installer (wizard; every deployment shape, see ## Guided installer)
infra/
  docker-compose.yml         dev (bundled single Cockroach node, or external DB)
  docker-compose.prod.yml    prod (bundled 3-node Cockroach, or external DB)
  caddy/Caddyfile            ingress config
tests/
  e2e/        Playwright suite (runs against the live compose stack)
  smoke/      API/HTTP regression suite (Node, runs against live stack)
  cluster/    multi-node harnesses (sim.sh, shape-d.sh, failover, backup-restore ...)
  installer/  install.sh tests: dry-run.sh (no docker), e2e.sh (real installs in throwaway copies)
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
`http`/`tcp`/`icmp`/`dns`/`tls`; per-kind config lives in the monitor's freeform
`options` blob, no migration to add a kind. The `tls` probe (`probeTls`) judges certificate
expiry only (down once expired or `warnDays` or fewer days remain), not chain trust, so private-CA
services work. A kind in `MONITOR_KINDS` needs a case in the worker's `runProbe`, or it reports
`unknown kind` (down). The
worker fans incidents out to the monitoring recipients like infra alerts), **Infrastructure**
(`/monitoring/infra` — host/Docker/Proxmox; the per-host detail page charts
CPU/mem/disk plus load/temperature — persisted into rollups — and network/disk-IO,
which are raw-sample-only so they populate at the ≤2h range), **Network (UniFi)**
(`/monitoring/network`),
**Network (Cisco)** (`/monitoring/network-cisco` — the `cisco` module: an SSH
poller for Cisco IOS/NX-OS switches with config backups, drift, MAC/ARP/VLAN
caches; ported from the standalone `cisco-switch` app. Port drift (`driftFieldsFor` in `cisco.poller.ts`) compares admin
state, mode, VLANs, **description, speed and duplex** with the running config. Speed is held as the switch writes it
(`1000`, `auto`) and every path goes through `normaliseSpeed` (shared), so `1G` and `1000` agree; a description is compared
exactly and must be one CLI line (the push refuses control characters). **VLANs (layer 2)** work the same way
(`cisco-vlans.service.ts`, `vlan-drift.ts`, `push-commands.ts`): the wanted list per switch is `cisco_vlans` (migration 0061;
`cisco_vlan_db` stays what the last poll saw), taken from the switch once per switch (`cisco_switches.vlan_baseline_at`, so
removing the last wanted VLAN is not "never seeded"), then compared on every poll and right after each edit as drift events
with `port_id = vlan:<id>` and field `vlan_exists` (`1`/`0`) or `vlan_name`. VLAN 1 and 1002-1005 are never managed
(`isManagedVlan`). Edits are `PUT /cisco/vlans/:vlanId` (name + the switches that should have it; others lose it) and
`DELETE`; a removal is refused (409) while a wanted or live access port, a trunk native VLAN or an `interface Vlan<id>` in the
latest backup uses it, and the push re-checks that. Nothing reaches a switch except through the drift push, which creates and
renames VLANs first, then ports, and removes VLANs last (`buildPushCommands`); the port editor picks its VLANs from the
switch's list (`GET /cisco/switches/:id/vlans`) and a port cannot be put in a VLAN the switch does not have. A trunk's allowed
list is compared as a set (`normaliseVlanList`). Per-switch VLANs assume VTP transparent/off (all three switches are): a
switch in VTP server/client mode would propagate edits, so do not add that without detecting it first. The push also reads the
session output and fails on `Invalid input` / `ERROR:` lines instead of reporting success. Reads gate on
`monitors:read:any`, writes on `monitors:write:any`), and **IPAM**
(its own page, `/ipam` in the IT menu, not a Monitoring tab since 2026-10-04;
`/monitoring/ipam*` redirects there via `next.config.mjs` — the `ipam` module: a
lightweight IP-address manager. A
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

Cisco SSH **pins the switch's host key** (`cisco_switches.known_host_key`, migration 0059): trust on first use,
then a different key is refused before the password is sent (`SshHostKeyMismatchError`, shown on the switch
page with a "Trust new host key" action: `POST /cisco/switches/:id/reset-host-key`). Changing a switch's IP
clears the pin. Writes to a switch (`pushToSwitch`, manual backup) refuse to run until a key is recorded
(`pinnedConn`). Test: `apps/api/test/cisco-host-key.test.ts` runs a real in-process ssh2 server.

There is also a **UPS** tab (`/monitoring/ups` — the `ups` module: an SNMP poller
over UPS-MIB / RFC 1628, mirroring the `printers` module — `ups_devices` table, a
`setInterval` poller in `ups.service.ts`, per-device SNMP creds falling back to
`monitoring.ups_*` settings; battery %, runtime, load, in/out voltage. Reuses the
`monitoring` permissions like cisco/ipam — reads `monitors:read:any`, writes
`monitors:write:any`, no dedicated module/permission strings).

There is also a **DNS** page (`/dns` in the IT menu, like IPAM not a Monitoring
tab; `/monitoring/dns*` redirects — the `dns` module: a client for a
Technitium DNS Server cluster running *outside* this stack, so port 53 never
touches compose). `dns/technitium.ts` calls the Technitium HTTP API with the token
as `Authorization: Bearer` (never in the URL); only the cluster **primary** is
configured (`dns.primary_url`, `dns.api_token`, `dns.verify_tls` in the
`monitoring` settings category) because it alone accepts zone edits and
aggregates cluster stats (`node=cluster`). Summary (primary
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
`dns.sync_enabled` is on. One run at a time across all nodes via the `dns-sync` lease
(`LeaseService.acquireMutex`, 120 s, renewed while it works); a second
request gets `AlreadyRunningError`.

**DNS health** (`dns/dns.health.ts`): "Create health monitors" on the Overview
adds one `dns` uptime monitor per node (cluster node IPs, or typed in) that
resolves the TXT canary `_dashboard-canary.<zone>` through that node, so a dead
node or a secondary that stopped receiving zone transfers opens a normal
incident. The canary carries the managed marker so it can't be hand-edited.
`dns.alert_unreachable` adds a notification-only alert (kind
`dns.primary_unreachable`, like UniFi's, since the primary's API isn't a monitor
row) after 3 failed 60s polls of the primary, plus a recovery notice; silenced
by maintenance mode. The dashboard monitoring tile has a DNS row (nodes up/down).

**Update runs and sudo** (`infra/infra-updater.ts`, `infra/sudo-access.ts`): "Run updates" on a Linux
infra target needs root. The script first probes sudo (`sudoProbeScript`: root, `sudo -n true`, or a password read from
stdin and piped into a fresh `sudo -S` for every command; never a cached credential reused with `sudo -n`, which
sudo-rs (Ubuntu 25.10+) refuses without a tty: "interactive authentication is required") and stops there if the run cannot go on, so apt is never run unprivileged. The run then
ends `needs_sudo` (key login with no password, or a wrong one: the web opens a terminal-style dialog,
`SudoTerminalDialog`, showing sudo's own output and a masked prompt) or `sudo_denied` (not in sudoers: the error
says how to fix it on the host; the dashboard cannot). The password typed is sent with the next
`POST .../update-run` (`sudoPassword`, redacted from the audit row, never stored, scrubbed from run output); with
`enablePasswordlessSudo` the run first writes `<login> ALL=(ALL) NOPASSWD: ALL` to
`/etc/sudoers.d/zz-church-dashboard-<login>` (`zz-` because sudoers is last-match-wins; temp name, `visudo -cf`,
then `mv`). "Written" is not "working": while still root the script runs `sudo -n true` as the login; if a later
entry overrides the rule it retries with `Defaults:<login> !authenticate` (sudo-rs has no such setting), and
failing that removes the file and returns `sudo -l -U` plus the relevant sudoers lines. A scoped sudoers rule does not satisfy the `sudo -n true` probe. Statuses are
free text in `infra_update_runs.status`, so no migration. Tests: `apps/api/test/sudo-access.test.ts` runs the
real scripts against a fake `sudo`; the real messages were also checked in a Debian container and over SSH.

**Switching an infra host off** (`infra_targets.enabled`, the toggle beside Edit on the host page): the collector
does not poll it, and `poll-now`, `discover-services` and update runs answer 409. Its open incidents stay recorded
but are left out of `openAlerts` and the open-incident list (nothing is polling it to resolve them); the summary
counts it under `targets.disabled`, not in `total`. Switching it back on clears `last_polled_at` and sets the
status to `unknown`, so it is polled at the next tick and the old reading is not mistaken for a current one. The
overview greys the card and says "Disabled"; the host page greys its last readings and shows a banner.

**Maintenance mode:** the `monitoring.maintenance_mode` boolean setting silences
alert *notifications* across infra thresholds, service up/down, UniFi
device-offline, DNS, cluster-node and Cisco switch alerts — incidents are still recorded, only the
in-app/email fan-out is paused. (UPS has no alert fan-out; IPAM none either.)
**It can carry an end time** (`monitoring.maintenance_until`, ISO timestamp, blank = none; at most 7 days at once,
`MAINTENANCE_MAX_MINUTES`) so a pause nobody remembers ends by itself. **Never read the boolean on its own to decide
whether to notify:** ask `readMaintenance(settings)` / `maintenanceActive(settings)` (`monitors/maintenance.ts`), and in the
probe worker `maintenanceState` (`packages/shared/src/maintenance.ts`, unit-tested), which judge the end time against the
current time on each call. The `maintenance-expiry` cluster job (`monitors/maintenance-expiry.ts`) then flips the stored
switch off so the settings page stays truthful; nothing depends on it. `POST /monitors/maintenance` takes
`{enabled, minutes?}` (no `minutes` = no end, which the Security overview flags as a warning). Presented as
an inverted "Enabled" switch (on = alerts fire, the default; off = a menu asking for 1/4/8/24 hours or "until I turn it
back on") right-aligned on the Monitoring tab row (`maintenance-control.tsx`, rendered
inside `MonitoringTabs`), which shows when alerts resume and lets the time be changed, via `GET`/`POST
/api/v1/monitors/maintenance`, or from `/admin/settings/monitoring`.

**Flapping, acknowledging, escalation and the status page** (migration 0064; pure rules in `packages/shared/src/alert-rules.ts`,
unit-tested; the probe worker cannot import the API, so the rules live in shared). (1) *Flapping* is the worker's
(`services/monitor/src/main.ts`): when an incident opens and `monitoring.flap_incidents` have opened within
`monitoring.flap_window_min`, `monitors.flapping_since` is set, ONE `monitor.flapping` notice goes out, and the down/up
notices (and activity rows) for that monitor are held back; incidents are still recorded in full. It ends when the monitor has
stayed in one state for the whole window (judged on every check, after that check's own writes: `flapSettled`), then a
"stable again" notice, or a normal "is down" one if it is down. Never read `flapping_since` as "down". (2) *Acknowledging*:
`POST /monitors/incidents/:incidentId/ack` (`monitors:write:any`, audited, idempotent, 409 once resolved) sets
`monitor_incidents.acknowledged_at/by`; incidents are shared by monitors and infra targets, so one route serves both.
(3) *Escalation* (`monitors/alert-escalation.ts`, cluster job `alert-escalation`, 60 s): for open, unacknowledged incidents
started within 72 h, `escalationDue` picks the step (1 = remind the usual recipients after `monitoring.escalate_reminder_min`,
2 = also tell the group named in `monitoring.escalation_group` after `monitoring.escalate_group_min`; the highest due step wins
and a step is never repeated). A step is CLAIMED with one conditional UPDATE on `escalation_level` BEFORE sending (two nodes
never double-send; a crash loses at most that one notice). Nothing is sent in maintenance mode; a missing or empty group
degrades to reminders with one log line; saving a group name that does not exist is refused (`SettingsService.assertReferences`).
The second group's notice links to `/status` because they may have no Monitoring access. `escalation_level`/`escalated_at` and
`flapping_since` are `volatile` in the backup registry (a restore must not replay or inherit them). (4) *The status page*
(`GET /status`, any signed-in user, no permission string by design; `StatusService`) lists monitors with `show_on_status` (and
enabled) under `status_name`, and carries NAME, STATE, SINCE, ACKNOWLEDGED, the maintenance window and the admin's
`monitoring.status_notice` only: **never add a target, address, error text or threshold to it**, a unit test asserts none
leaks. Tests: `alert-rules.test.ts`, `alert-escalation.integration.test.ts` (CockroachDB and YugabyteDB), smoke
`tests/smoke/alerts.mjs`, e2e `status.spec.ts`; the worker's flap behaviour was checked for real against a stopped and
restarted container (no automated test: `applyResult` lives in the worker's `main.ts`).

**Helpdesk: waiting, SLA notices, saved replies, tickets from email** (migrations 0065 and 0066; rules in `packages/shared/src/helpdesk.ts`
and `inbound-mail.ts`, unit-tested). (1) *Waiting on the requester* is ticket status `waiting`, with `tickets.waiting_since` while it lasts and
`waited_ms` for finished waits: **SLA elapsed time is always `ticketSlaElapsedMs`** (creation to now minus the waits), never a bare
`now - createdAt`; `waitingTransition` does the bookkeeping on every status change (`TicketsService.update` and the reply path) and
`statusAfterRequesterReply` puts the ticket back to work when the creator posts a public comment (including by email). Staff-facing
counts (home section) leave waiting tickets out; the requester still sees theirs. (2) *SLA notices* (`tickets/ticket-sla.ts`, cluster job
`ticket-sla`, 60 s): `slaAlertsDue` picks warn (at `tickets.sla.warn_percent`) and breach per clock; each is CLAIMED by one conditional UPDATE
on `tickets.response_warned_at/response_breached_at/resolution_warned_at/resolution_breached_at` before sending (volatile in the backup
registry); a notice more than `SLA_ALERT_STALE_MS` late is flagged silently (first run after upgrade must not announce history);
a priority change clears the flags, reopening a finished ticket clears the resolution ones; recipients are the assignee, else everyone in a
group with moderator/admin on Tickets plus the admin group. (3) *Saved replies* (`ticket_canned_replies`, `tickets/canned-replies`, list needs
`tickets:read:any`, writes `tickets:admin`): placeholders are filled by the web with `renderCannedReply`, an unfillable one stays visible.
(4) *Tickets from email* (`tickets/ticket-inbound.ts`, job `ticket-inbound` 60 s, `mutex:ticket-inbound`, settings category `helpdesk`,
`tickets.inbound.*`, site-admin only, routes `tickets/inbound/{status,test,check}` are `@SessionOnly` and MCP-excluded): read-only IMAP
(`imapflow`, `mailparser`: the only inbound-mail code; versions pinned and older than two weeks when added) that tracks `{uidValidity,
lastUid}` in `job_state` (first look = last 24 h only) and records every message by Message-ID in `ticket_inbound_log` (unique; the real
dedupe; `skip` in the backup registry; 90-day prune). **Never trust a From line**: a sender must be an active, approved account with
`tickets:write:own` AND pass `senderAuthenticated` (`strict` DMARC pass by default, `aligned`, or `off`), judged only on an
Authentication-Results header written by `tickets.inbound.auth_server` when that is set (`pickAuthResultsHeader`). **The mailbox never
sends anything back** (no bounces, no auto-replies: no loops, no backscatter), skips auto-generated mail, the site's own address and a
sender over 30 messages/hour. A subject with `[#n]` comments on that ticket if the sender can read it (quoted text cut by
`stripQuotedReply`), otherwise a new ticket is opened (a forwarded message is the request, so new tickets keep quoted text). Ticket emails
get `[#n]` in the subject and `Reply-To` = the help address only through `CreateNotificationInput.ticketNumber`, and only for notices the
requester may see (never an internal note: a reply would publish it). `TicketEvents` is the one place that fans out ticket realtime and
notifications, shared by the routes and the mailbox. Tests: `helpdesk-rules.test.ts`, `inbound-mail.test.ts`, `ticket-helpdesk.integration.test.ts`,
`ticket-inbound.integration.test.ts` (DB tests on CockroachDB and YugabyteDB; with `TEST_IMAP=host:imapPort:smtpPort` it also runs against a
throwaway GreenMail), `notification-reply-to.integration.test.ts`, smoke `tests/smoke/helpdesk.mjs`, e2e `helpdesk.spec.ts`.

**Wiki upkeep: templates, backlinks, review, history** (migration 0067; rules in `packages/shared/src/wiki-pages.ts`, unit-tested in
`apps/api/test/wiki-pages.test.ts`). (1) *Backlinks are computed, never stored*: `WikiService.backlinks` finds bodies containing
`/wiki/<id>` with a `LIKE`, then confirms with `extractWikiLinks` (code is ignored; `/edit`, `/revisions` are not page links) and
filters by `readablePredicate`, so there is no link table to drift, back-fill or restore and an edit shows on every node at once.
A page the caller cannot read is never named. Fine for a church-sized wiki; if it ever grows to thousands of large pages,
that is the moment for a table (maintained in `create`/`update`/`revertToRevision`/import). (2) *Review*: `wiki_pages.last_reviewed_at/by`,
`review_interval_days` (null = site setting `wiki.review.default_days`, default 180; 0 = never) and `review_notified_at`
(volatile in the backup registry). **A page is due when `wikiReviewState` says so: the clock starts from the LATER of `updated_at` and
`last_reviewed_at`**, so editing counts as looking and confirming (`POST /wiki/:id/review`) is not an edit: no revision, `updated_at`
untouched, no "page updated" notices (`WikiWritesService` also skips them for an interval-only PATCH). Changing the interval needs
owner or wiki admin (`canManage`), like visibility. The `wiki-review` cluster job (hourly) notifies owners with kind
`wiki.review_due`, one message per owner per run; each page is CLAIMED by a conditional UPDATE on `review_notified_at`, and the flag
only counts while newer than the page's last edit/review (`wikiReviewNotice`), so nothing needs resetting. A page already
overdue by more than `WIKI_REVIEW_NOTICE_WINDOW_MS` is flagged silently (turning the check on must not announce history).
(3) *Templates*: built-ins are code (`WIKI_STARTER_TEMPLATES`, ids `starter:*`), saved ones are `wiki_templates` (list needs
`wiki:read:own`, writes `wiki:admin`, audited `wiki.template.*`); `{{date}}`/`{{author}}` are filled in the web. (4) *History*:
the diff model is `apps/web/src/lib/wiki-diff.ts` (unit-tested in the web package: line diff, word marks inside paired changed
lines, folded unchanged runs; both texts are given a final newline first, or the last line always differs). The page picker
(`components/wiki-page-picker.tsx`) renders in a portal: inside the editor, `fixed` is relative to the editor box. MCP: three
hand-written read tools; confirming a review and saving templates are not tools (a person's claim / admin curation, rules in
`route-rules.ts`). Tests: `wiki-upkeep.integration.test.ts` (CockroachDB and YugabyteDB), smoke `wiki-upkeep.mjs`, e2e
`wiki-upkeep.spec.ts` (a page can only become due by time, so only the integration test covers that).

**Notification delivery: quiet hours, daily summary, push** (migration 0068; rules in `packages/shared/src/notification-delivery.ts`, unit-tested in
`apps/api/test/notification-delivery.test.ts`). Channels per kind are `in_app`, `email`, `push` (push opt-in: a kind with no saved row never pushes).
**All routing goes through `NotificationsService.create/createMany`**: in-app is always immediate and silent; **push is sent immediately except during
quiet hours, and is then DROPPED, not queued** (`pushAllowed`); **email is held in `notification_held` when `emailReleaseAt` says it is not due yet**
(quiet hours, or a daily summary) and sent by the `notification-release` cluster job (60 s). A held row stores what the email says, never a release
time: due-ness is recomputed from the person's CURRENT `notification_delivery` row (quiet start/end, summary time, `urgent_through`, minutes after
midnight on the SITE zone `site.timezone`), so changing settings applies to waiting mail. Rows are CLAIMED by deleting them before sending (two nodes
never double-send; a crash loses at most that email, the bell has it); one held notice goes as itself, two or more as one summary (`HELD_EMAIL_MAX_ITEMS`);
anything held over 3 days is released regardless. `URGENT_NOTIFICATION_KINDS` (down alerts) skip quiet hours and the summary unless the person turned
`urgent_through` off. **A new kind that means "something is down now" belongs in that list.** *Push* (`notifications/push.service.ts`, `web-push` pinned):
the VAPID key pair is DERIVED from `AUTH_SECRET` (`vapid.ts`; the derivation strings never change; rotating the secret orphans subscriptions, which are
removed when the push service answers 404/410), so there is no key storage and every node agrees. **A subscription endpoint is user-supplied and the server
POSTs to it, so only `isAllowedPushEndpoint` hosts (FCM, Mozilla, Apple, Windows) over https/443 are accepted: never loosen that (SSRF).** Routes `/me/push/**`
are `@SessionOnly` and MCP-excluded; `GET|PUT /me/notification-delivery` are ordinary tools. `push_subscriptions` and `notification_held` are `skip` in the
backup registry (device credentials / a queue), `notification_delivery` is data. The page list never returns an endpoint (only `endpointFingerprint`). The
service worker (`apps/web/public/sw.js`) handles `push` and `notificationclick` (only same-origin URLs); `/sw.js` is a PUBLIC middleware path (behind the
sign-in redirect a browser refuses to register it). Tests: `notification-delivery.integration.test.ts` (CockroachDB and YugabyteDB), `push.test.ts`
(derivation, a verified VAPID signature, the endpoint allowlist), smoke `notification-delivery.mjs`, e2e `notification-delivery.spec.ts` (the browser's push
manager is stubbed: headless Chromium has no push service and refuses subscribing in incognito; a real device round trip was never run).

**Command palette** (`apps/web/src/components/command-palette.tsx`; what it offers is decided ONLY by the pure `paletteCommands` in `apps/web/src/lib/palette.ts`,
unit-tested in `palette.test.ts`). A `go` command needs the module (any tier; admin pages need `access.admin === "admin"`); a `run` command reuses an existing
audited route and is offered by PERMISSION STRING from `GET /me` (read when the palette opens), never by tier guesses: pausing alerts needs `monitors:write:any`,
which is the monitoring ADMIN tier. The route still decides; a failure is shown in a toast. **An action that changes what other people see (pausing alerts) must
set `confirm`**, which shows a confirmation step (Escape backs out of it first). Page context comes from the address (`currentThing`: `/tickets/<uuid>`,
`/wiki/<uuid>...`). A new action = a `RunCommand` here, a case in `execute`, a test. The palette sets `data-palette-ready` on `<html>` once Ctrl+K is heard (tests
wait for it); the dialog wrapper itself has no size, so assert on the search box, not the dialog. e2e `palette.spec.ts`.

**Accessibility** (Part 2 item 10; sweep and keyboard tests in `tests/e2e/tests/zz-accessibility.spec.ts`, `@axe-core/playwright` pinned). The spec runs axe
(WCAG 2.2 AA + best practice) over every screen, a detail screen of each kind and the open menus/palette, in light and dark, desktop and 390 px, and **fails on any
violation**: a new screen cannot add one, and an exception goes in `ACCEPTED` with a reason. Rules the code now follows: (1) *text colour pairs*: muted text is
`text-slate-500 dark:text-slate-400` (never `slate-400` alone on a light page, never `slate-500` alone on a dark one); links `text-brand-600 dark:text-brand-400`;
status colours `-700` in light with a `dark:` partner (`-600` on white fails); text on a `brand-50/100` tint uses `slate-600`; never dim text with `opacity-*`.
(2) *Every control has a name*: an icon-only button needs `aria-label` (say what it acts on: `Remove <thing>`), a blank table heading needs `sr-only` text (`Column.srLabel`
in `DataTable`), a form field needs a real `<label htmlFor>` (the Settings fields tie label, description and input together). (3) *Landmarks*: two `<nav>`s on a page need
different `aria-label`s; each page has one `<main>`; `SkipLink` (first Tab stop) focuses it. (4) *Hand-built dialogs* use `DialogFrame`/`useModal`
(`components/modal.tsx`): focus goes in, Tab stays in, Escape closes, focus returns to the opener; give the panel `role="dialog"`, `aria-modal` and a name. (5) A
horizontally scrolling table wrapper with nothing focusable inside needs `tabIndex={0} role="region" aria-label="..."`, or a keyboard user cannot scroll it. (6) Click
targets are at least 24 px (WCAG 2.2). (7) Ctrl+K belongs to the command palette alone (the top-bar search used to answer it too), and the palette hands focus back to
what had it. (8) `prefers-reduced-motion` switches off the app's transitions and pulses (`globals.css`); spinners keep turning. axe finds about a third of real
problems: keyboard order, focus and what a screen reader says are checked by the keyboard tests and by hand, and no assistive technology was run against the app.

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
   (see ### API tokens)

`web` reads the provider config from the internal-only endpoint
`/api/v1/auth/providers/internal` (gated by an `X-Internal-Token` derived from
`AUTH_SECRET`, and 404'd by Caddy on the public proxy). A toggle can't be enabled
until its credentials are present — enforced by `TOGGLE_PREREQUISITES` in
`packages/shared/src/settings.ts` and the settings UI.

### API tokens

Personal bearer tokens (`cdt_` + 32 random bytes, base64url) for scripts and
agents; module `apps/api/src/api-tokens/`, shared schemas in
`packages/shared/src/schemas/api-token.ts`, migration 0049. Only the SHA-256
hash and the first 8 characters are stored; the plaintext is in the create
response once, and `@Audited({ redactKeys: ["token"] })` keeps it out of the
audit snapshot.

- **A token acts as its owner, narrowed:** `AuthService.findUserByApiToken`
  loads the owner through the normal `loadUserById` (so group changes apply at
  once and a disabled/deleted owner's tokens die), then `scopeUserToToken`
  (`auth/api-token-scope.ts`, unit-tested) intersects `permissions` with what the
  token's `modules` could grant and cuts `access` to them. It returns a copy: the
  owner record is shared through the user cache. `read_only` tokens get a 403 on
  any non-GET/HEAD/OPTIONS in `SessionGuard`.
- **Bearer is judged alone:** a request with `Authorization: Bearer` never falls
  through to the cookie. Unknown, revoked, expired, and "feature off"
  (`auth.api_tokens_enabled`) all give the same 401. Bearer requests skip the
  TOTP-enrolment gate (creating a token is session-only, so it already passed).
- **Three levels:** read-only, read and write, and `allow_operational` (migration 0058, off for every older token; needs a
  non-read-only token). `@OperationalOnly()` (`auth/operational-only.decorator.ts`) marks a route that acts on live
  equipment (switch ports and pushes, DNS record writes and sync, scans, polls, host OS updates, ProPresenter slides);
  `SessionGuard` gives a bearer request without the level a 403, a browser session is unaffected. The MCP `operational`
  tools are exactly these routes (`mcp-coverage.test.ts`), hidden from `tools/list` and refused for other tokens. A new
  route that touches equipment gets the decorator.
- **`@SessionOnly()`** (`auth/session-only.decorator.ts`) refuses bearer requests:
  token create/revoke (own and admin), password change, `PATCH /me` (email), and
  the whole TOTP controller. Put it on anything that would let a leaked token
  outlive revocation or take over the account.
- **Lifetime:** every token expires within `auth.api_tokens_max_days` (default
  365; 0 also allows "never"); default 90 days. Revoking sets `revoked_at`;
  tokens are never deleted, so `audit_log.api_token_id` keeps resolving (the
  audit list returns `apiTokenName`). `last_used_at`/`last_used_ip` are written at
  most once a minute.
- **Endpoints:** `GET|POST /me/api-tokens`, `DELETE /me/api-tokens/:id`;
  `user:admin`: `GET /admin/api-tokens?status=&userId=`,
  `DELETE /admin/api-tokens/:id`, `POST /admin/users/:id/api-tokens` (issue to a
  service account), `POST /admin/users/:id/api-tokens/revoke-all`.
- **UI:** `/me/api-tokens` (own tokens; linked from the user menu and the profile
  page), `/admin/api-tokens` (everyone's, filter by status), and an "API tokens"
  section in the `/admin/users` Manage drawer (count, issue to this user, revoke
  one/all). Shared pieces are in `apps/web/src/components/api-tokens.tsx`; the form
  reads `GET /me/api-tokens/policy` (enabled, max days) because non-admins can't
  read settings. The audit table shows "via token <name>". Docs: INSTALL.md
  "Using the API".
- **Not covered:** the Socket.IO handshake still reads the session cookie only.

### Sessions, sign-out and sign-in hardening

- **Sessions can be ended server-side.** `users.session_version` (migration 0060) is stamped into the cookie's JWT as
  `sv` when the web signs someone in (`jwt` callback in `apps/web/src/lib/auth.ts`, read from the database because
  OAuth users come from the adapter). `AuthService.revokeSessions(userId)` bumps it; `SessionGuard` and the realtime
  handshake refuse a cookie whose `sv` differs (`auth/session-version.ts`; a cookie without `sv` counts as 0, so
  the upgrade signed nobody out). It is bumped by: password change, password reset by link, admin password reset,
  admin 2FA removal. Everything that ends a session also needs the caller to sign in again: tests and scripts that
  change the password must sign in afterwards (smoke and `tests/cluster/*` do).
- **One browser can be signed out alone** (`user_sessions`, migration 0062; `auth/sessions.service.ts`). The web puts a random
  `sid` in the cookie's JWT at sign-in (`jwt` callback); the API creates the row the first time `SessionGuard` sees it
  (`SessionsService.touch`: at most one write per session per 5 minutes per node, never on the request path, address and
  browser from that request) and ending a session sets `revoked_at`. The revoked ids ride along with the cached user
  (`AuthenticatedUser.revokedSessions`, loaded by `loadUserById`; `invalidateUser` drops it on every node), so judging a
  cookie costs no query: `sessionIsCurrent` checks `sv` and `sid`, in `SessionGuard` and the realtime gateway. Routes
  (`@SessionOnly`, in `me.controller.ts`): `GET /me/sessions`, `DELETE /me/sessions/:id` (`current` = this browser; it
  upserts, so signing out right after signing in still ends the session), `POST /me/sessions/revoke-others`,
  `POST /me/sessions/revoke-all` (bumps `session_version`: also ends cookies that have no `sid`). Admin:
  `GET /users/:id/sessions`, `POST /users/:id/sessions/revoke`. The web's sign-out button calls `DELETE .../current` first.
  An ended row is kept 90 days and an idle one 30 (`sessions-prune` job), so a stray cookie never revives a session;
  never delete a revoked row sooner. Cookies from before the table have no `sid`: not listed, ended by "sign out
  everywhere". `apiFetch` forwards the browser's User-Agent (the audit log's `user_agent` used to say "node").
  `describeUserAgent` (`packages/shared/src/user-agent.ts`) turns it into "Firefox on Windows".
- **`POST /me/change-password` needs `currentPassword`**, except for a forced change (`mustChangePassword`) and for an
  account with no local password yet. The web profile form signs the person out after it.
- **Failed sign-ins are counted per account** (`RateLimitService.failures/recordFailure/clearFailures`, same
  `rate_limit_buckets` table, key `acct|<identifier typed>`, existing account or not): 10 failures in 15 minutes
  refuse further attempts with 429 `too_many_attempts`; a success clears it. `verify-credentials` always spends the
  time of one argon2 check (`verifyPasswordOrDecoy`) and says "deleted" only after the right password.
- **Public reset routes** (`/auth/tokens/request-reset`, `/consume`) share the strict 10/min/IP bucket. A reset email is
  sent at most once per account per 5 minutes; a link is claimed with one conditional UPDATE (single use under
  concurrency), refused for a disabled or deleted account, and spends the account's other outstanding links.
  The email's link comes from `site.url`/`APP_URL` only (never from the request); with neither set it logs a warning
  and the link is relative.
- **The realtime socket** refuses a handshake whose `Origin` is not this site (`handshakeOriginAllowed`: Host or
  X-Forwarded-Host, or the `APP_URL` list) and every 30 s re-reads each connected user (disconnect when gone, disabled
  or signed out; leave rooms the user lost access to).

### Security overview (admin)

`/admin/security` (`site:admin`, `@SessionOnly`, `GET /admin/security-posture`) lists how the site is set up as checks
(`critical` / `warn` / `info` / `ok`): the install password still in place, administrators without two-factor, Google and
Microsoft sign-in scope, pending approvals, API tokens that never expire or sit idle, Cisco switches with no pinned host
key, maintenance mode, Site URL, SMTP, backup age, offsite copies, audit retention. `SecurityPostureService` only gathers counts and
settings (never a secret); the rules are the pure `evaluatePosture` in `packages/shared/src/security-posture.ts`
(unit-tested), the page only draws them, and every row says its status in words and an icon. **A new security-relevant
setting or policy gets a check there** (a fact in `PostureFacts`, a rule, a test); it reads, it never fixes anything.

### TOTP / 2FA is optional, off by default

TOTP enrolment is **per-user** and **opt-in**. Two policy knobs in the settings
table can require it:

- `auth.require_totp_admin` — every member of the `admin` group must enrol.
- `auth.require_totp_all` — every signed-in user must enrol.

Both default to **off**. When on, the `SessionGuard` lets affected users
authenticate and read (GETs pass) but refuses all mutating requests until
they complete `/auth/totp/enroll` + `/auth/totp/confirm`. Recovery: a user with
recovery codes signs in with one (single use); an admin can remove someone's 2FA at
`/admin/users` (Manage > Two-factor, `POST /users/:id/totp/reset`, which also signs them out everywhere).
The TOTP secret is stored encrypted (`enc:v1:` like other secrets; a plaintext row is encrypted on first read), so a
backup restored under a different `AUTH_SECRET` leaves 2FA accounts needing that admin reset. A code is accepted once
(`totp_secrets.last_step`) and a recovery code is spent atomically (`AuthService.verifyTotpCode`/`consumeRecoveryCode`).

There is no "admin role implicitly requires TOTP" in the code — earlier
versions of these docs claimed there was; that claim was aspirational, not
enforced. The two settings above are the only TOTP gates.

### Account gating & lifecycle

`SessionGuard` enforces these gates; each blocks everything but a narrow
allowlist until cleared (and each throws a **403**, not a 401 — the enforcement
calls run outside the cookie-decode try/catch so the 403 isn't swallowed):

- **`must_change_password`** — set on the bootstrap admin, on admin password
  resets, and optionally on admin-created users. Blocks everything, reads
  included, except `GET /me` and `POST /me/change-password`
  (`enforceMustChangePassword`, unit-tested); the web force-routes to
  `/change-password`. Reads are blocked on purpose: the seeded `admin`/`admin`
  must not be able to browse the instance's data before a real password is set.
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

**Who may sign in through OAuth** is decided by the pure functions in
`packages/shared/src/oauth-policy.ts` (tested in `apps/api/test/oauth-policy.test.ts`), called from the
`signIn` callback in `apps/web/src/lib/auth.ts`: Google must report `email_verified`, and a Google
account counts as a workspace member only if its `hd` claim equals `google.workspace_domain` (the web
sends it as `hostedDomain` to `oauth-provision`; an absent field, from an older web build, falls back to
the address). Microsoft sign-in is refused when no allowed domains are set and the tenant is a shared
endpoint (`common`/`organizations`/`consumers`); the allowed-domain list is matched against the user
principal name, never the free `email` claim (only a single tenant also falls back to `email`).

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

The snapshot is the route's response, and `AuditService.write` runs `scrubSnapshot` (`audit/audit-scrub.ts`) on `before` and
`after` of every row: a string or object under a key that looks like a credential (`password`, `token`, `authorization`,
`community`, `secret`, `api key`, `cookie` ...) is stored as `[hidden]`. Nothing has to opt in; `redactKeys` on `@Audited` only
drops a key outright. A key that is only an identifier or count (`tokenId`, `prefix`) is left alone. Test: `audit-scrub.test.ts`.

A handler whose action depends on what the request turned out to do (the MCP
endpoint multiplexes reads and writes over one POST) calls
`startDynamicAudit(req)` and then `recordAuditEntry(req, {...})` per change
(`audit/audit.decorator.ts`); the interceptor then writes exactly those
entries instead of the route-level row, so a read-only request writes none.

## MCP server

`/api/v1/mcp` (`apps/api/src/mcp/`) is a Streamable HTTP MCP server for agents,
e.g. a Claude Code session documenting systems in the wiki. Stateless: each POST
builds a fresh low-level SDK `Server` + transport bound to the caller and answers
with plain JSON (GET/DELETE 405). **API tokens only**: the controller refuses a
request without `user.apiToken` (i.e. a browser session). Every call is a POST,
so the route carries `@ReadOnlyPerOperation()` to let read-only tokens past
SessionGuard's method check, and `McpToolsService.call` refuses any tool not
annotated `readOnlyHint: true` for them. Module-limited tokens need nothing
extra: SessionGuard already narrowed `user.permissions`. Tools
(`mcp.tools.ts`) call the same services as the REST routes (`WikiService`,
`WikiWritesService`, `WikiFoldersService`), so permissions, page ACLs, revisions,
search, realtime and notifications match the UI; each tool also checks a
permission string against `user.permissions`. Audit entries carry the token id
like every other token request. `wiki_update_page` requires
`expectedUpdatedAt` (WikiService.update refuses with 409 if the page changed).
No delete tool by design. The SDK sees hand-written JSON Schemas; inputs are
validated with zod in the tool (the SDK needs zod >= 3.25, hence the workspace
pin). Tests: `apps/api/test/mcp-tools.test.ts` (incl. the SDK client over HTTP).
When adding a tool: JSON Schema + zod args + permission + `recordAuditEntry`
for writes.

**The rest of the app is reached through a route bridge, not through services**
(plan, phases and rules: [docs/mcp.md](docs/mcp.md)). A catalogue tool
(`apps/api/src/mcp/bridge/catalogue/*.tools.ts`, `defineTool`) names one REST route,
reuses the route's Zod schema for its input (the JSON Schema is generated, never
hand-written), and `ApiBridge` calls the route in-process with `inject` carrying the
caller's own bearer token. That keeps guards, token limits, audit (with the token id),
and the controller's own side effects (realtime, notifications) identical to REST;
never call a service from a new tool when a route exists. **Every route must be a tool or
named in `route-rules.ts` with a reason** (`mcp-coverage.test.ts` fails otherwise): add
a tool and delete its `pending` rule, or add an `excluded` rule. `tools/list` shows a
caller only the tools its permissions allow (read-only tokens: reads only). Read-only
admin, no delete tools for tickets/wiki/accounts, and a future "operational" token level
for equipment-touching tools are decided (2026-10-12). A tool whose route returns a credential
sets `redact` (values become `[hidden]`) or `transform` (settings, audit: `bridge/scrub.ts`); devices with logins (hosts, printers, UPS, switches)
are registered in the web app only.
Files on tickets, notes and wiki pages are tools too (`catalogue/attachments.tools.ts`, `bridge/attachments.ts`): a tool with `binary: "download"` answers with
content blocks (an image as an image, text as text, other types described only) and `binary: "upload"` sends `text` or `contentBase64` (1 MiB) to the route as
multipart. No delete tool.

## Activity feed

`GET /activity` and the home page's activity section go through `ActivityService.list(user, limit)`, which holds
each event to the read rule of the thing it is about (`visibleTo`): a note's event is only ever its owner's, a
ticket's is its creator's or a `tickets:read:any` holder's, a wiki page's follows visibility + ACL (or
`wiki:read:any`), infra/monitor events need `monitors:read:any`, and an event type the filter does not know is
visible to its actor only. **A new kind of event must be added to `visibleTo`**, or it stays private. Test:
`apps/api/test/activity-visibility.integration.test.ts` (needs `TEST_DATABASE_URL`; empties the tables it uses).

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

**One Meilisearch per node, derived from the database.** Meilisearch cannot be
clustered, so each node runs its own and keeps it in step; nothing in the index
is the only copy of anything, and any node can rebuild its index from the
database (admin **Reindex**, or the reconcile at start). Code is split across
`search.service.ts` (the service), `search-types.ts` (kinds, `SearchDoc`,
`searchDocId`; re-exported from the service), `search-sources.ts` (where
documents come from: `DbSearchSources`, plus the ticket/note/wiki doc builders),
`search-helpers.ts` (`docRev`, `diffDocs`) and `live-search.store.ts`.

Every document carries `rev`, a hash of its content (not its `updatedAt`). A
**reconcile** compares each indexed doc's `rev` with the desired one and writes
or deletes only the difference, so documents never vanish and reappear.
**Never write to Meilisearch directly from a feature**; go through the service.

Indexed kinds (see `SearchKind` in
[apps/api/src/search/search-types.ts](apps/api/src/search/search-types.ts)):

- **Content:** `ticket`, `note`, `wiki`. After the database write, a service
  calls `search.changed(kind, id)` (deleting counts as "changed" too). That node
  re-reads the resource from the database and updates its index at once, and
  tells the other nodes over the cluster bus (internal room `__search`), which
  re-read it themselves, so a change always lands as the current database
  content, never as a payload. A full reconcile of the content kinds also runs at
  start and every 10 minutes (`SEARCH_CONTENT_RECONCILE_MS`) to heal anything the
  bus missed.
- **Monitoring (DB-backed):** `monitor`, `infra_target`, `infra_entity`,
  `cisco_switch`, `cisco_port`, `cisco_mac`, `cisco_arp`, `cisco_vlan`,
  `ipam_subnet`, `ipam_host`. Each node reconciles these from the database
  itself (`syncMonitoringDbSources()`): on startup, on a timer
  (`SEARCH_MONITORING_SYNC_MS`, default 120s, so poller churn is picked up
  without a manual reindex), and from Reindex. Not event-driven, so two nodes
  can differ by a poller's latest changes for up to that long.
- **Live kinds, not in the database** (`LIVE_KINDS`): `dns_record` and
  `unifi_device`/`unifi_client`. The one node that reads the source publishes
  the current set with `syncDns()` / `syncUnifi()`, which writes only changed
  rows to the `live_search_docs` table and tells the other nodes; every node
  indexes from that table, so a node never needs to reach Technitium or the UniFi
  controller to search them, and a new node has them straight away.
  `DnsSearchIndexer` does a full read of every zone on a timer
  (`DNS_SEARCH_SYNC_MS`, default 300s) and shortly after each dashboard write; an
  unconfigured server clears the kind, an unreachable one keeps the last set. The
  `UnifiPoller` pushes on each poll and self-refreshes on an idle cadence
  (`UNIFI_SEARCH_SYNC_MS`, default 300s). Right after upgrading from a version
  without the table, these documents are absent until the next poll (under a
  minute for DNS, one poll for UniFi).

Search is **eventually consistent across nodes** (about a second): a ticket
created on one node can be missing from a search answered by another for a
moment. A freshly started node answers searches only after its first reconcile
(up to 8 seconds' wait, then it answers anyway). Admin **Reindex** rebuilds this
node's index and asks every other node to rebuild theirs (bus event `reindex`).

**Permission gating happens in the query filter, never at index time** (so a
permission change takes effect immediately): monitoring kinds require
`monitors:read:any` (as does `dns_record`), UniFi kinds require `unifi:read:any`, tickets/wiki apply
their own read scoping. A user without a permission simply never gets those
kinds in the filter — nothing leaks through the index. When adding a new
searchable resource: add the `SearchKind`, a doc builder in `search-sources.ts`
(with `url`) and the code that calls `search.changed` (or, for a source outside
the database, a publisher through `live_search_docs`), the query gate, and an
entry in `search-kinds.ts`.

## Attachments (allowed types)

Which file types may be uploaded (wiki, notes, tickets share `AttachmentsService`) is the admin-editable setting
`attachments.allowed_types` (Site settings > Attachments, `attachment-settings.tsx`). **The choices are a closed catalogue,
`ATTACHMENT_TYPE_CATALOGUE` in `packages/shared/src/schemas/attachment.ts`, never free text**: the stored list is cut down to the
catalogue on read (`resolveAllowedAttachmentTypes`) and on save (`validateSettingValue`), so HTML, SVG and
`application/octet-stream` can never be switched on. Each entry has a `check` that `reconcileMime`
(`attachments/magic-bytes.ts`) applies to the file's own bytes: `magic` (sniffed type must equal the declared one), `zip`
(docx/xlsx/pptx/OpenDocument), `ole` (legacy doc/xls/ppt), `none` (plain text formats). To add a type, add a catalogue
entry with a check that can verify it (a new signature goes in `sniffMime`); defaults are `DEFAULT_ATTACHMENT_TYPES`
(unchanged from before the setting existed). Only images are served inline; everything else is `attachment` + nosniff.
**Custom extensions** (`attachments.custom_extensions`, "Other file extensions" in the same section) are the deliberate
exception to "verified": matched by the file NAME only (they win over the browser's declared type), stored and served as
`application/octet-stream` (download-only, nosniff), and `normaliseCustomExtension` refuses `BLOCKED_ATTACHMENT_EXTENSIONS`
(html, svg, xml, js, exe, bat, sh, php ... anything that runs in a browser, on a computer or on a server) and any extension
the checklist already covers (so unticking a type there cannot be undone here). The same function runs in the UI, in
`validateSettingValue` and when the setting is read (`resolveCustomAttachmentExtensions`). Settings are cached 60 s per node,
so editing the row in SQL (instead of the UI, which invalidates) takes up to a minute to apply. The upload size cap is still the fixed `MAX_ATTACHMENT_BYTES`. Tests: `apps/api/test/attachment-types.test.ts`.

## Home page looks

The home page (`/`) can be shown in six looks that each person picks (plan and decisions: [docs/dashboard-themes.md](docs/dashboard-themes.md);
the original concepts: `docs/dashboard-concepts/`): `tiles` (the original draggable grid, `app/dashboard-tiles/`), `start`, `nave`,
`toward-sunday`, `glass` and `front-of-house` (`apps/web/src/app/home/looks/<id>/`). Rules for changing them:

- **One snapshot, many renderers.** `GET /api/v1/dashboard/home?include=` (`apps/api/src/dashboard/home/`) returns a `HomeSnapshot`
  (`packages/shared/src/dashboard/home.ts`). Every section is `{state:"ok",data}` or `unconfigured|unavailable|forbidden`, is
  permission-gated in its own builder (`sections/*.section.ts`) and runs under a 2.5 s timeout, so one slow source costs only its
  section. Optional parts (`week`, `readiness`, `availability`, `meters`) are built only when a look asks for them. Looks are
  presentation only: they read the snapshot through `useHomeSnapshot` (30 s poll, window focus, `monitoring`/`infra` realtime
  signals; never the `network` room, which turns the UniFi poller on) and never fetch their own data. The rules (what "needs you"
  means, the summary sentence, week events, readiness, availability buckets, meter scales) are pure functions in
  `packages/shared/src/dashboard/`, tested in `apps/api/test/home-*.test.ts`.
- **Cost control (measure with a signed-in script before changing: the snapshot was ~600 ms for every poll).**
  (1) `HomeService.snapshot` coalesces identical simultaneous requests (same person, access and `include`) into one
  build and keeps nothing afterwards, so a refetch after an action always sees its effect: never add a TTL there.
  (2) Sections whose answer is the same for everyone who may see them (`systems`, `meters`, the availability and
  week-incident reads) are computed once per few seconds (`SYSTEMS_SHARED_MS`, `METERS_SHARED_MS`,
  `WEEK_SHARED_MS`, `HOURLY_READ_CACHE_MS`) and shared; the permission gate stays outside the cache, and anything an
  action changes (maintenance mode, the write flag) is read live. A new section that is the same for everyone
  belongs behind a `TtlCache` like these; one that depends on the person (tickets, checklists, wiki ACLs) does not.
  (3) Reads of other systems use `TtlCache.get(..., { failTtlMs, deadlineMs })`: a dependency that is down or slow
  costs one wait per window, not one per request, and is not asked again meanwhile. The cache is bounded
  (`maxEntries`). Cached arrays/objects are shared between callers: never mutate what a cached read returns.
- **Nothing is faked.** A section that is not `ok` is hidden or says why in one plain line. `unavailable` with reason
  "no upcoming service" means nothing is scheduled that this person can see: hide, never "can't be reached".
- **Actions reuse existing audited routes** (UniFi ack, take a ticket, tick a checklist task, maintenance mode) through
  `home/parts/need-action.tsx` and the looks. The only new write is `PUT /dashboard/prefs` (audited `dashboard.prefs.update`).
- **Choosing a look:** `?theme=` (preview, not saved) > the device cookie `church_home_look` ("use on this device only",
  `/api/dashboard/device-look`) > `dashboard_prefs.theme` > setting `dashboard.default_theme`. A look missing from
  `dashboard.enabled_themes`, or whose `requires` the person lacks (Glass and Front of House need `monitors:read:any`), falls
  through; `start` is the last resort (`resolveLook` in `packages/shared/src/dashboard/themes.ts`). `?kiosk=1` hides the nav for a
  booth screen. `dashboard_prefs.sections` holds each person's hidden optional sections per look (`optionalSections` in the
  catalogue; unknown ids are dropped).
- **Every look ships light and dark:** two complete token sets in its CSS Module (`.root` and `:global(.dark) .root`), WCAG AA
  checked by `scripts/check-look-contrast.mjs` (list new text/background pairs there), fonts via `next/font/google` inside the
  look's folder (only that look's chunk loads them), motion only inside `prefers-reduced-motion: no-preference`, and no
  horizontal scroll at 390 px. Check a change in both schemes.
- **Time** is shown in `site.timezone` (IANA name; `zoned.ts` helpers are DST-safe). Format dates from `zonedParts` by hand, not
  with `Intl` presets in rendered text: Node and the browser ship different ICU data, and a differing comma caused a React
  hydration error (#418).
- **Availability history:** `AvailabilitySampler` (`apps/api/src/availability/`, `ClusterJobs` jobs `availability-sample` every
  minute and `availability-prune`, 8 days) adds one up/down sample per system to `availability_hourly`; Glass's window and Toward
  Sunday's health strips read it. A source that is unconfigured or unreachable records nothing ("no data"), never "down".
- **Adding a look:** a `LOOK_IDS` entry and `DASHBOARD_LOOKS` definition (requires, includes, optionalSections, thumbnails
  `apps/web/public/home-looks/<id>-light|dark.png`), a folder under `looks/` whose root carries `data-look="<id>"`, an entry in
  `home-root.tsx`, and an e2e spec `tests/e2e/tests/home-<id>.spec.ts` that never performs a real action.

## Database

The app speaks the Postgres wire protocol (`pg` + Drizzle) and supports three
deployments, chosen by `DB_MODE` in `.env` and applied by `scripts/compose.sh`
(the Makefile, `rebuild.sh` and the `pnpm dev:*` scripts all go through it):

- `DB_MODE=bundled` (default): CockroachDB inside the stack (single node dev,
  3 nodes prod), in the `bundled-db` compose profile. `DATABASE_URL` is set for you.
- `DB_MODE=external` + `DATABASE_URL`: an existing **YugabyteDB** (YSQL, :5433)
  or **CockroachDB** cluster. The bundled profile is off.

Deployments never name the engine: `apps/api/src/db/connection.ts` reads
`DATABASE_URL` (falling back to the old `COCKROACH_URL`) and `detectEngine()`
classifies `SELECT version()` (`CockroachDB …` / `…-YB-…` / plain PostgreSQL).
Engine-specific behaviour is confined to `scripts/migrate.ts`:

- **YugabyteDB doesn't support DDL inside a transaction block** (each DDL bumps
  the catalog version and a long transaction gets aborted), but drizzle's
  migrator wraps *all* pending migrations in one transaction. On YugabyteDB,
  migrate applies statements one by one and records them in drizzle's own
  `drizzle.__drizzle_migrations` table with drizzle's rules; Cockroach and
  Postgres keep drizzle's transactional migrator. A YB migration that fails
  halfway leaves earlier statements applied, so prefer `IF NOT EXISTS`.
- **`gen_random_uuid()`** is built in on Cockroach and PG 13+ bases, but on
  YugabyteDB 2024.2 (PG 11 based) it needs `pgcrypto`, which migrate enables.

Portability rules for new SQL (verified against Cockroach 24.2, YugabyteDB
2024.2 LTS and 2026.1):
- No CockroachDB row-level TTL (`ttl_expiration_expression`). Retention lives in
  the app: infra metrics are pruned by `InfraCollector.prune()` (raw 7d, 5m
  rollups 90d, 1h rollups 365d). Migration 0030 originally set Cockroach TTL;
  installs that ran it keep it, harmlessly.
- No `DELETE … LIMIT` (Cockroach-only): batch with
  `WHERE (pk…) IN (SELECT pk… LIMIT n)`.
- No `LISTEN/NOTIFY` and no `DO $$` blocks (Cockroach < 24.3); no
  Cockroach-only syntax (`UPSERT`, `STRING`, `AS OF SYSTEM TIME`, `crdb_internal`).
- `count(*)::int` comes back as a string on Cockroach (INT8) and a number on
  YugabyteDB/Postgres (INT4): wrap with `Number()` when the value matters.

## Cluster coordination (multi-node)

The app runs as several peer nodes behind an external load balancer
(`DEPLOY_MODE=cluster`); the plan, status and decisions are in
[docs/multi-node.md](docs/multi-node.md). Shape C (bundled database on every node) and shape D
(your own database and object store) have both run end to end on one host, D on CockroachDB and on
YugabyteDB (`tests/cluster/`); real multi-host behaviour (latency, partitions) is untried. New code
must keep a second node working:

- **Periodic work goes through `ClusterJobs.register(...)`**
  (`apps/api/src/cluster/`), never a bare `setInterval`/`setTimeout` loop. Every
  node runs every timer; only the node holding the job's `job:<name>` database
  lease does the work. On one node it is always the leader, so behaviour is
  unchanged. `schedule: "fixed-delay"` replaces a self-rescheduling
  `setTimeout`; the default `fixed-rate` replaces `setInterval`. Per-node work
  (rebuilding that node's own search index) is the exception and is not leased.
- **"Only one of these at a time" is a lease, not a boolean field.** A unit of
  work any node may start (a button press, an edit trigger) uses
  `LeaseService.acquireMutex` / `withMutex`; the DNS sync is the example.
- **State a job must keep across a handover** (alert baselines, failure
  counters) goes in `job_state` via `JobStateService`, not a `Map` on the
  service. Small JSON only.
- **Leases are judged by the database clock** (`now()`), never `Date.now()` on a
  node. Node identity is `NODE_ID` (compose defaults it to `main`); it must be
  unique per node.
- **Migrations must work with the previous release** (expand/contract): nodes
  upgrade one at a time, so for a while the old code runs against the new
  schema. Add columns and tables first; remove or rename in a later release.
  `migrate.js` holds the `migrate` lease, so concurrent runs serialise.
- `main.ts` enables shutdown hooks, so `onModuleDestroy` runs on SIGTERM; the DB
  pool closes in `onApplicationShutdown`, after it. Put cleanup that needs the
  database in `onModuleDestroy`. `ClusterJobs` waits (up to 6s) for jobs that
  are mid-run before the pool closes, then releases the leases.
- **Realtime across nodes** goes through `RealtimeGateway` (`toUser`, `toRoom`,
  `toRoomSnapshot`), which emits to this node's sockets and, through
  `ClusterBus` (`realtime_events`, polled about once a second), to the other
  nodes'. User-room events always go out; resource rooms go out only while
  another node has a viewer (`realtime_presence`). Ask "is anyone watching?"
  with `realtime.hasViewers(room)` (any node), never a local socket count. A
  payload too big to send on every change (the UniFi snapshot) goes through
  `toRoomSnapshot`: stored once in `live_snapshots`, other nodes get a pointer.
  Delivery is best effort, like the Redis pub/sub it replaced; nothing stored
  may depend on it.
- **In-memory caches** (user permissions, settings) are dropped on other nodes
  by publishing on `CACHE_ROOM`; do the same for any new per-process cache that
  a write must invalidate.
- **Outgoing email** goes through `MailQueue` and the `mail_outbox` table (any
  node claims, 5 attempts with backoff, at-least-once). Call
  `MailerService.sendBestEffort`; do not send inline.
- **Strict rate limits** (sign-in, TOTP, password change) set
  `config.rateLimit.shared`, which counts in `rate_limit_buckets`; the general
  per-IP limit stays per node.
- **Open database pools only with `createPool` from `@church/shared/db`**, never
  `new Pool(...)`. It adds the `error` handler (a plain pool exits the process when
  a database node dies and an idle connection breaks), named connections
  (`application_name`), timeouts, a 30-minute connection lifetime, TLS from the
  URL, and automatic retry of statements that are safe to repeat. `@church/shared/db`
  is a separate entry point (not the main index) so browser bundles never pull in
  `pg`; classic-resolution packages find it through `packages/shared/db/package.json`.
- **`DATABASE_URL` may list several hosts** (`postgresql://u:p@h1:5433,h2:5433,h3:5433/db`, libpq syntax): `createPool`
  then uses `HostSet`/`multiHostClient` (`packages/shared/src/db/pool.ts`): each new connection goes to the host with
  the fewest open from this process, a host whose connect failed is left out for 5 s (doubling to 60 s), and the
  failed attempt is a "never reached the database" error, so `withRetry` (and the same retry wrapped around
  `pool.connect()`) tries the next host. A one-host URL takes the old path untouched. Nodes are not discovered:
  they are the ones in the URL. Parse URLs with `parseDbUrl`, never `new URL()` (it rejects the host list).
  **Do not add the YugabyteDB smart driver (`@yugabytedb/pg`)**: it was built in, tested against a real three node
  cluster and removed (global connect state and a lock; its retry after a failed host left a connection attempt
  that never finished or timed out in 3 of 5 runs of the unwrapped driver, see docs/multi-node.md).
- **Every statement has a client-side timeout** (`DB_QUERY_TIMEOUT_MS`, default 60 s, `queryTimeoutMs` per pool, 0 for
  migrations): a host that hangs or loses power keeps its connections open and silent, and without it the statements
  on them wait minutes for TCP. A timed-out statement drops its connection and counts as "ambiguous" (retried only if
  it is a read). Statements that may legitimately run longer need their own pool with a larger value.
- **What the pool retries:** anything that never reached the database or that the
  database rolled back (40001, 40P01), and a plain SELECT/SHOW/EXPLAIN whose
  connection broke. **An ambiguous write is never retried** (it may have applied):
  it fails and the caller or user retries, so make a write that matters idempotent.
  A `WITH` counts as a write. Wrap a whole idempotent operation with `withRetry`
  if it needs more.
- **Database TLS:** `?sslmode=verify-full&sslrootcert=/path/ca.crt` in the URL, with a
  **host name, not an IP** (pg treats `require`/`verify-ca` as `verify-full`;
  `HostCheckingClient` checks the certificate against the real host even for an IP, but
  names are what certificates carry).
- **The `monitor` worker shares work through claims:** `claimDueMonitors`
  (`services/monitor/src/claim.ts`) takes due monitors with `monitors.claimed_until`;
  the claim is cleared when the check is recorded. Anything new the worker does that
  must happen once per cluster needs a lease (`acquireLease`, as its prune does).
  `scripts/rebuild.sh` rebuilds `monitor` as well as `api` and `web`.
  Each check records the node that made it (`NODE_ID`, passed to the `monitor` service in both compose files;
  `monitor_checks.node_id`, `monitors.last_checked_by`, migration 0055). `GET /api/v1/monitors/workers`
  (`MonitorsService.workers`) gives per-node figures for the last 10 minutes; the Services page shows a "Probe
  workers" strip, a "via <node>" line on each row, and on a monitor's page a "Checked by" card and a "By node"
  table that points out a node failing far more than the others. All of it is hidden unless `clustered` (more
  than one `full` node registered, or checks from more than one node), so a single node looks as before.
  Each probe-worker card also shows the node's build (`cluster_nodes.version`, i.e. `BUILD_ID`); `checkBuilds`
  (`packages/shared/src/builds.ts`, tested in `apps/api/test/cluster-builds.test.ts`) turns the cards that differ from
  the majority of live nodes red (all of them when there is no majority), with a banner naming the builds.
- **Every node must run the same build.** The web app's static files and (in other
  setups) Server Action IDs are named by the build, so a page from one node and a
  request answered by another must come from the same one. `scripts/build-id.sh`
  gives the id (the commit, or `<commit>-<hash of uncommitted changes>`); compose
  passes it as `BUILD_ID` to the api, web and monitor images; `next.config.mjs`
  uses it as the Next build id and `deploymentId`; `scripts/release.sh` builds the
  images once for a cluster to share. Builds of the same clean commit are
  byte-for-byte alike.
- **Server Action IDs are salted by a fixed build-time key** (the web Dockerfile), so
  they are identical in every build. The key that really encrypts action closures
  is derived from `AUTH_SECRET` at start (`apps/web/entrypoint.sh`); do not add a
  separate secret for it. Never remove the fixed build key: Next otherwise makes a
  random one per build and two nodes stop agreeing (measured: no IDs in common).
- **Realtime is WebSocket only** (gateway and clients), so the load balancer needs no
  sticky sessions. Do not add `polling` back.
- **Load balancer contract:** `/healthz` on the proxy (200 with `X-Church-Node` while
  the API reaches the database, 503 otherwise, 503 `draining` while
  `data/caddy/drain` exists; `scripts/cluster.sh drain|undrain|status`).
  `TRUSTED_PROXIES` (the balancer's CIDRs) turns on strict `X-Forwarded-For`
  parsing in the proxy; unset keeps the old trust-everyone behaviour on purpose.
  The API's `/api/v1/readyz` answers 503 when degraded; keep it that way.
- **`scripts/rebuild.sh`** rebuilds api, web and monitor and recreates/restarts the
  proxy when its config changes. A new service or a new config file needs adding
  to it, or `make rebuild` will silently not apply it.
- **Object storage is configured through `resolveS3Config`** (`attachments/s3.config.ts`) and
  `getS3()`; never read `MINIO_*` / `S3_*` directly. `S3_*` names win, `MINIO_*` are the
  fallback. `S3_MODE=bundled|external` (decided in `scripts/compose.sh`) controls the bundled
  Garage profile (`bundled-s3`). Only path-style addressing is tested. **Never use `mc` with the
  keys in a URL** (`MC_HOST_*`): it does not decode percent-encoding and keys contain `/+=`;
  `mc` also compares only name and size, so verify content by hash (`scripts/s3-copy.cjs`).
- **The bundled store is Garage** (`infra/garage/`: a small image that adds a shell to the
  static binary, a config, an entrypoint, an idempotent `garage-init`). MinIO was dropped
  because `minio/minio` and `minio/mc` can no longer be pulled from Docker Hub or quay.io. Rules:
  (1) Garage accepts only its own key format (`GK` + 24 hex, 64-hex secret), so
  `scripts/compose.sh` **derives the key, secret and RPC secret from `AUTH_SECRET`** (explicit
  values must match the format); nothing for the operator to set, and every node of a cluster
  gets the same ones. A key from before an `AUTH_SECRET` change stays valid. (2) Its metadata
  is LMDB and **must not be on NFS/SMB**: the entrypoint refuses to start there; `GARAGE_META_DIR`
  moves it. This repo's `./data` IS on NFS on the dev host, so `.env` sets `GARAGE_META_DIR`
  to a local folder. (3) The app region for the bundled store is `garage`. (4) Compose
  interpolates inactive-profile services too, so any `${VAR:?}` in a profile service needs a value
  exported by `compose.sh` in the other mode (see `GARAGE_RPC_SECRET`). (5) Use
  `scripts/compose.sh --s3-env` to learn what the app uses; do not re-derive it elsewhere.
- **Cluster mode is a compose overlay, chosen by `scripts/compose.sh`.** `DEPLOY_MODE=cluster`
  (production stack only) adds `infra/docker-compose.cluster.yml` (publishes Garage's RPC
  port), `docker-compose.cluster-db.yml` when `DB_MODE=bundled` (one secure `cockroach` service,
  profile `cluster-db`, plus the CA mounted into api/monitor/web) and
  `docker-compose.cluster-s3-api.yml` when `CLUSTER_S3_API_PORT` is set. compose.sh validates
  (NODE_ID, NODE_ADDR, CLUSTER_PEERS, role/mode combinations) and prints what it resolved with
  `--cluster-env`: scripts use that, never re-parse `.env`. Only the shell environment's and
  `.env`'s values reach compose interpolation, so a new knob is read with `conf` in compose.sh
  and `export`ed there. `CLUSTER_PEERS` entries may be `host:dbport:rpcport` (several nodes on one
  host, as in tests).
- **Bundled cluster database is secure Cockroach.** The app signs in as user `church` (password
  `derive_ns db/password` from `AUTH_SECRET`, created by `cluster.sh init-db`) over
  `sslmode=verify-full` against `data/certs/ca.crt`; each app talks to its own node's database. The
  CA key (`data/cluster-certs/ca.key`) never goes on a node (`install-certs` refuses a bundle that
  has it). The admin UI is not published. The cockroach healthcheck is unhealthy until `init-db`,
  by design, so a new node's first start is `cluster.sh start-data` (not `up`), then `init-db`,
  `garage-bootstrap`, `migrate`, `seed`, `up`. **`derive`/`derive_ns` strings never change** (they
  are live credentials).
- **Migrate and seed in a cluster use a one-off container** (`cluster.sh migrate|seed`, i.e.
  `run --no-deps api ...`): the app cannot start on an empty database, so `exec api` is not
  available on a first install.
- **Readiness must touch a range.** `/api/v1/readyz` reads a real table under a server-side
  `statement_timeout` (on CockroachDB `SELECT 1` is answered without any range, so a node that lost
  its quorum would pass it). `SettingsService.get` serves a stale cached value when a refresh is slow
  (one refresh in flight per key): the rate limiter reads a setting on every request, and without
  this a stalled database stalled the liveness endpoint too.
- **Garage's config is a template** (`infra/garage/garage.toml.tpl`, rendered by
  `garage-render.sh` from `GARAGE_RPC_PUBLIC_ADDR` / `GARAGE_REPLICATION_FACTOR`); run the CLI as
  `garage -c /tmp/garage.toml`. The copy count is fixed at creation (3 with 3+ nodes, else 2). The
  layout across nodes is formed by `cluster.sh garage-bootstrap`, never by `garage-init` (which in
  cluster mode only does key and bucket). Replacing a dead node is **one** layout change
  (`garage-join ... --replace <old id>`: assign the new node, remove the old, apply, then
  `skip-dead-nodes --version N`); doing it in two steps leaves versions the dead node can never
  acknowledge and writes fail with "Could not reach quorum". A restore replaces the database for all
  nodes, so `db-s3.sh restore` refuses while another node's app is up, and hands the restored tables
  to the `church` user.
- **Cluster tests: `tests/cluster/`** (`sim.sh` builds N nodes on one host from copies of the repo,
  each with its own `.env`, `data/` and compose project; `cross-node.mjs`, `failover.sh`,
  `replace-node.sh`). **Never run the production stack from this checkout on the dev host**
  (`make prod-up`, `compose.sh --prod up`): it bind-mounts the same `./data` directories as the live
  dev stack. Use the simulator, or `compose.sh --prod config` to look.
- **A change must be visible on every node at once** (`cluster/read-your-writes.ts`). A per-process cache
  that a write must invalidate drops the other nodes' copies through `CACHE_ROOM` (see the cache rule
  above); the ordering guarantee is separate: in a cluster every mutating response first flushes the bus
  (`ClusterBus.flushNow`) and sets a 10 s `church_rv` cookie, and a request carrying it makes its node run
  a poll first (`ClusterBus.syncSince`). Without that the smoke suite fails through a load balancer
  (password change then write: 403, settings, TOTP). Next route handlers that proxy the API must relay the
  cookie (`forwardToApi` does); server actions calling `apiFetch` do not yet. Cookie-less clients (API
  tokens) get "within about a second": write tests for them to allow for it.
- **The admin Cluster page** (`apps/api/src/cluster-admin/`, `/admin/cluster`) reads the same tables the
  coordination uses (`cluster_nodes`, `cluster_leases`) plus a database and object-store probe and, for the
  bundled Garage, its admin API (`GARAGE_ADMIN_URL`/`TOKEN`, set by `compose.sh`). What counts as a problem
  is the pure `findProblems` (unit-tested); a new background job appears there by registering with
  `ClusterJobs` (its name lists the job). The `cluster-watch` job notifies admins when a node stops
  checking in and when it returns (baseline in `job_state`, silenced by maintenance mode).
- **Cluster tests live in `tests/cluster/`**: `sim.sh` (shape C), `shape-d.sh up|test|down` (shape D:
  a throwaway database, a standalone Garage, two nodes, a Caddy load balancer; runs smoke and the browser
  suite through the balancer, which is what found the read-your-writes gap), `failover.sh`,
  `replace-node.sh`, `witness.sh`, `restore-node-death.py`, `node-watch.mjs`, `backup-restore.{sh,mjs}`,
  `compose-config.sh`. Address the balancer as `localhost` for browser tests (the clipboard API needs a
  secure context). Never `tee /dev/stderr` into a log (it truncates the file); never `pkill -f` a pattern
  that appears in your own command.
- **Raw `pool.query` returns timestamps as strings.** `drizzle()` replaces pg's
  timestamp parsers for the whole process. In raw SQL return epoch milliseconds
  (`extract(epoch FROM ts) * 1000`) instead of relying on `Date`. The
  integration test calls `drizzle(pool)` for the same reason.
- **Search changes** go through `SearchService.changed()` (content) or
  `syncUnifi`/`syncDns` (live kinds); see ## Search. Do not add a node-local
  update path for the index.
- **Database failover test**: `tests/db/yb-failover.sh` builds a three node YugabyteDB cluster, runs steady traffic
  through `createPool` with all three hosts in the URL and makes nodes hang, refuse and stop underneath it through
  `tests/db/tcp-fault-proxy.mjs` (a container frozen with `docker pause`, or reattached to its network, breaks
  YugabyteDB itself and tests nothing about the pool). `apps/api/test/db-multihost.integration.test.ts` runs with
  `TEST_DATABASE_URL`.
- **Real-database tests**: `test/db-stores.integration.test.ts` runs the stores'
  SQL against a real engine when `TEST_DATABASE_URL` points at a migrated
  scratch database (it empties the cluster tables). Run it on Cockroach and
  YugabyteDB when changing that SQL.

## Guided installer (`install.sh`)

`./install.sh` (repo root, bash 4+, no Node needed) is the supported way to install: it asks, writes
`.env` and runs the real steps (`scripts/compose.sh`, `scripts/cluster.sh`), so it never has its own
copy of a procedure. Operator docs: INSTALL.md "Guided installer". Rules for changing it:

- **A new bootstrap setting in `.env.example`, or a new install step, needs the installer updated** in the
  same change: a question (`ask_*`), `write_env`, and a case in `tests/installer/dry-run.sh`. Keep every
  question answerable from `--answers` (the keys are the `ANS[...]` names; `ENV_<NAME>` writes any `.env`
  key) so tests and unattended installs work; never read a prompt without going through `ask_*`.
- **Asking again offers the earlier answers as defaults** (`PREV`, filled by `load_prev` on "answer again" and by `forget` /
  the review-no loop; secrets keep the saved value on Enter). `PREV` is only ever a default: an answer from `--answers` or
  a resume is `ANS`, and nothing is asked. `CONFIRM` is never remembered (a "no" must not become the next default).
- **Read answers only through `read_line`** (used by every `ask_*`): on a terminal it uses readline (`read -e`), so
  Backspace/arrow keys edit the answer; a bare `read` stores the erase key as a literal `^H`. Saying no at the
  review re-asks everything that was asked at a prompt (`ASKED`); answers from `--answers` are kept.
  `tests/installer/pty-edit.py` types a typo and fixes it with both `^H` and DEL in a real pty.
- **The wizard's database test also checks the login may CREATE tables** (`test_one_host` line 3: schema `public` missing /
  no CREATE on it / no CREATE on the database), failing with the exact GRANT commands, because the migrations otherwise stop
  at their first statement ("permission denied for schema public") after a long build. `tests/installer/db-perms.sh`
  (PostgreSQL 16 container with a non-owner login; CockroachDB unchanged).
- **`sslmode` means something different in this app than in psql.** pg 8 treats `require`/`prefer`/`verify-ca` as
  `verify-full`; only `no-verify` skips the check. The wizard offers verify-full / no-verify / disable, its connection test
  translates the URL for psql so it behaves like the app (`test_url_for_psql`: a test that passes where the app fails is
  worse than none), and an untrusted certificate offers `no-verify` (never applied silently). An old saved `DB_SSL=require`
  becomes verify-full. `tests/installer/db-tls.sh` runs it against a PostgreSQL container with a self-signed certificate.
- **Values go into `.env` unquoted**, so `v_envsafe` rejects whitespace, quotes, backslashes, backticks, `#`
  and `$`; the database URL's user and password are percent-encoded (`urlenc`), because compose interpolates
  `$` in env files.
  Secrets never go on a command line (`docker run -e NAME`, not `-e NAME=value`) or into `.install.log`.
- **Steps are stages** (`run_stage name desc fn`, recorded in `.install-state`): idempotent, skipped on a
  re-run, and a stage that needs another machine uses `pause` (skipped by `NOWAIT=yes` in tests). A single
  server follows the cluster order, not `make up`: the API cannot start on an empty database, so it starts
  the database, runs migrate and seed in one-off containers (`run --rm --no-deps api`), then `up`.
- **Versions are checked, and a mismatch is offered a fix, never forced** (`offer_self_update`, `sync_to_commit`,
  `restart_installer`, `forget_stale_progress`): a newer upstream is offered as a fast-forward `git pull`; a `--join` whose
  commit differs from the package's is offered `git fetch` + fast-forward/checkout of THAT commit (not "latest": the first
  node's exact version); both refuse a checkout with uncommitted changes. After changing files the installer `exec`s
  itself again (`ORIG_ARGS`, `SELF`): never carry on running a script that was replaced under bash. A package records its
  commit, so packages are rebuilt on every first-node run and the code-dependent stages are dropped when
  `scripts/build-id.sh` changed since the state file's `buildid:` line. SSH installs set `JOIN_COMMIT_OK=yes` remotely
  because the files were copied and the build ids compared. `tests/installer/update.sh` uses real throwaway git repos.
- **Image builds are retried when Docker's image store is damaged** (`build_images`, `BUILD_STORE_ERROR`: "failed to
  prepare extraction snapshot ... parent snapshot ... does not exist", a containerd race with parallel builds or an
  interrupted build/prune): one image at a time, then an offered `docker builder prune -f` (build cache only; never
  images or volumes), and any other build error is shown untouched, never retried. `tests/installer/build.sh` uses a fake
  compose/docker with the real error text. A new build step must go through `build_images`, not a bare `compose build`.
- **Every connection pins `search_path=public`** (`createPool`: `options: "-c search_path=public"`, unless the URL sets
  `options` itself). Migrations create unqualified tables and six foreign keys (0026, 0027, 0044) name `"public"."..."`
  explicitly, so tables landing anywhere else break them with 42P01. PostgreSQL's default `"$user", public` does exactly
  that when a schema is named like the login (reproduced on YugabyteDB: login `church_tech` + schema `church_tech` = 43
  tables in the wrong schema, then `relation "public.users" does not exist`). Never add schema-specific code paths.
- **A migration that fails halfway must be re-runnable** (YugabyteDB applies statements one by one, not in one transaction):
  `migrateStepwise` writes a marker (`drizzle.__church_migration_progress`) before a migration's first statement and removes
  it once the migration is journaled; a run that finds the marker is RESUMING and skips statements whose effect is already
  there (`ALREADY_DONE` SQLSTATEs), a run without one gets no such leniency, so a genuine error is never hidden. All the DDL
  of a YugabyteDB migration runs on ONE connection (a backend always sees its own changes, wherever in the host list it
  landed). `[migrate] failed: <message>` is printed FIRST and the failing statement named. The installer's one-off steps
  (`oneoff_api`) retry only on "database not reachable" output (`TRANSIENT_DB_ERROR`): any other error stops at once and the
  FIRST failure is shown, because a retry on a half-applied migration buries the real cause under a second, confusing error.
  `tests/installer/oneoff.sh` (fake compose); the resume was tested by killing a real migration on a 3-node YugabyteDB.
- **Missing requirements are offered, never silently installed** (`ensure_requirements`, `FACTS_SCRIPT`, `priv_exec`):
  one facts script (package manager, root/sudo state, what is missing) runs locally or over ssh; make/git/tar go in
  through the package manager after a yes/no (`AUTO_INSTALL_DEPS`), Docker only through Docker's own script after a
  default-no question (`AUTO_INSTALL_DOCKER`), the docker group after a yes (`AUTO_DOCKER_GROUP`). Root runs it, passwordless
  sudo uses `sudo -n`, a sudo password needs a terminal (`ssh -t` remotely, so the prompt reaches the person) and otherwise
  fails with the reason. A group change needs a new login session: locally the installer stops and says so, remotely it
  closes the ssh master and reconnects. Answers are loaded BEFORE the preflight (it asks). `tests/installer/deps.sh`
  runs it in clean Ubuntu/Debian/Fedora/Alpine containers, as a sudo user and over ssh to an sshd container; the Docker
  script itself is not run in tests.
- **The other nodes can be installed over SSH from the first** (`REMOTE_MODE=ssh`, the `remote_*`/`rsh` helpers and the
  `remote-prepare`/`remote-start`/`remote-finish` stages): the first node copies its checkout (WITH `.git`, so
  `scripts/build-id.sh` gives every node the same build id; it is compared before anything is built), the node's package
  (under the git-ignored `data/`, a stray untracked file would change the build id) and an answers file, then runs
  `./install.sh --join` over ssh in two phases (`INSTALL_STOP_AFTER=node-id`, or `build` with an external database and
  store, then the rest), all remote nodes in parallel. ssh connection sharing (`ControlMaster`) carries it: the one
  interactive moment (a password or host key prompt) is `remote_connect`; everything else is `BatchMode`. **The installer
  never reads or stores a password.** Every remote stage starts with `remote_connect_all`: a run that RESUMES skips
  `remote-prepare`, so it has no shared connection, and the prompt-free `rsh` would fail with "Permission denied" on a
  machine that needs a password; `ssh -O check` finds missing connections and `remote_connect` reopens them (asking again;
  with no terminal it says to use a key). A remote `--join` has no terminal, so anything it would ask must be in its answers
  (`NODE_<n>_ANS_<KEY>`); a network file system for Garage's metadata is refused with a clear message instead.
- **A cluster's other nodes get a package** (`data/cluster-packages/`, mode 600: that node's `.env` with the
  secrets, its certificates, the commit) and run `--join`. The package never contains `ca.key`. The join
  refuses a different commit unless told otherwise: every node must run the same build.
- **Tests**: `tests/installer/dry-run.sh` (fast, no docker: shapes A-D, validation, the real prompts through
  a pipe) and `tests/installer/deps.sh` (requirements), `tests/installer/update.sh` (versions), `tests/installer/ssh-password.sh` (a password-only machine, resumed), `tests/installer/db-tls.sh` (a self-signed database), `tests/installer/oneoff.sh` (migrate/seed retries), `tests/installer/build.sh` (a damaged image store), `tests/installer/db-perms.sh` (a login that cannot create tables) and `tests/installer/e2e.sh single|external|external-cluster|cluster|cluster-ssh|down` (real installs in `~/church-wiz`, own ports,
  project names and images, the live dev stack untouched; `single` ends with the smoke suite, `cluster` with
  `tests/cluster/cross-node.mjs` against all three nodes).
  Run `shellcheck -S warning install.sh` (`koalaman/shellcheck` in docker).

## Backups and restores (admin > Backups)

Admin > Backups (`apps/api/src/backup/`, pages in `apps/web/src/app/admin/backups/`, `site:admin`,
`@SessionOnly`) makes logical backups of the app's own data, schedules them, and restores them with a
comparison report. Operator docs: INSTALL.md "Backups and restores in the app". Rules for changing it:

- **Every table needs a decision in `backup/table-registry.ts`** (`data` = saved and restored, `skip` =
  neither). A unit test (`backup-registry.test.ts`) fails when a table is added without one, when a
  `data` table has a foreign key to a `skip` table (a restore could break it), or when a registry entry
  names a column that is gone. `volatile` columns (rewritten by pollers) are ignored by the comparison
  and left alone by a restore; `sensitive` ones are never shown; `sequences` are moved past restored
  values (`tickets_number_seq`). Never put the audit log, runtime state or the `backup*` tables in a backup.
- **The archive format is an order contract** (`archive.ts`): manifest, tables (parents first, every
  table at least one part), `files.json`, files, `summary.json`. Readers stop at the first file when they
  only need rows. Change the format only with a new `ARCHIVE_VERSION` and a reader for the old one.
- **A restore is a sync inside one transaction** (`backup-restore.ts`): `computeDiff` (stream the
  archive against the live tables, fingerprint rows) produces both the report and the plan; `applyRestore`
  follows the plan (delete children first, upsert parents first, self-referencing tables ordered, a
  cycle filled in afterwards). Any failure rolls everything back. Rows are written with typed casts from
  the Drizzle column types (`row-codec.ts`): timestamps and bigints travel as text, `jsonb` as JSON, and
  the session time zone is UTC for every read, or fingerprints would differ.
- **A restore can be limited to sections** (`restoreSections()` in the registry; the section is the table's `group`).
  A table whose group is not in `SECTION_ORDER` could never be restored on its own (a unit test fails). `computeDiff` takes
  a `scope` (tables + whether files) and only plans those tables; `backup-scope.ts` then reconciles the plan with foreign keys
  BEFORE the report and the apply (the report is exactly what happens): rows whose parent outside the scope no longer exists
  are SKIPPED (and so is what depends on them, also through self references) when the link is required; an optional link (a nullable column such as a creator or assignee) is written empty instead (`plan.nullify`, reported as "cleared", as ON DELETE SET NULL would); a REQUIRED owner/author of notes, tickets, ticket comments and wiki pages (`REASSIGNABLE_TO_UNKNOWN`) is written as the "Unknown user" placeholder (`UNKNOWN_USER` in `backup-scope.ts`, a disabled, soft-deleted user created by the restore only when needed, `plan.reassign`; never given personal data or assignments, which are skipped); and removals still referenced by backed-up
  tables outside the scope are KEPT (propagating to the parents of kept rows). Files (restore and stray cleanup) happen only
  when the Files section is in scope (`filesInScope`). All sections chosen = `scope: null` = the ordinary full rollback, same
  code path. It follows only foreign keys that reference the parent's whole primary key (a unit test asserts every FK does).
  The UI locks Restore until the report was made for the current selection. Integration test:
  `backup-scope.integration.test.ts` (run on CockroachDB and YugabyteDB, **one integration file at a time**: they empty the
  same tables, so running two in parallel makes both fail).
- **Sections follow the app's menus, not the table layout**: Monitoring holds everything under the Monitoring menu (services,
  infrastructure, UPS, Cisco, IPAM, UniFi acks); Printers is its own. A user looking for "the Cisco switches" ticks Monitoring.
- **A restore writes a NEW row without its volatile columns** (`insertColumns` in `backup-restore.ts`: the database default
  applies, e.g. status `unknown`, no last reading) when the column has a default or is nullable: a poller's last reading from the
  backup is stale the moment it is restored, and a host that cannot be polled must not look alive on it.
- **Credentials saved under another `AUTH_SECRET` fail loudly**: read them with `decryptStoredSecret(enc, what)` (throws
  `UnreadableSecretError`, whose message says to enter it again), never bare `decryptSecret`, and show the error on the device
  (`infra_targets.last_error`, `cisco_switches.last_error` via `markUnreachable`). Rows are still restored; the report says how many
  hosts/switches need their password again.
- **Anything that writes in the background must honour the restore gate**: a restore holds the
  `mutex:restore` lease (`RestoreGate`, `restoreInProgress` in `@church/shared/db`). The API refuses
  non-GET requests (`RestoreWriteGuard`), `ClusterJobs` skips runs and the monitor worker pauses. A new
  poller or worker outside those must check it too. The gate opens, and its one-second cache is waited
  out, before the operation reports success.
- **One operation at a time, cluster-wide** (`mutex:backup`), with progress in `backup_operations`; a
  running row that stops updating belongs to a dead node and is failed by the scheduler job. Steps after
  the restore's commit are best effort (warnings), never a failure of a committed restore.
- **Offsite copies** (`backup/offsite.service.ts`, `backup-offsite.ts` in shared, settings category `backup`, migration 0063):
  the archive is copied byte for byte to a SECOND S3 bucket (`backup.offsite.*` settings; the secret key is a `secret`
  setting; the switch has a `TOGGLE_PREREQUISITES` entry; a bucket equal to the app's own is refused). It goes through
  the same `ObjectStore` interface (`S3ObjectStore` takes its client and bucket; `makeS3Client`), so tests use
  `MemoryObjectStore`. Rules: (1) the `backup-offsite` cluster job (5 min) only picks up READY, `kind = scheduled`
  backups whose schedule has `offsite` on, within the newest `keep`, whose `offsite_dest` is not the current destination
  (a changed bucket re-copies); a manual or safety backup is copied only by the per-backup button. (2) Every copy runs as
  an `offsite` operation under the ordinary operation lease (`BackupService.beginOperation`), so it excludes restores and
  deletes of that backup; never copy outside it. (3) A copy is KEPT only after the size and the recorded SHA-256 match;
  failures set `offsite_error`, retry after `OFFSITE_RETRY_MINUTES`, and notify admins once until something succeeds.
  (4) Retention at the destination deletes only keys that `isOffsiteArchiveKey` accepts (our name pattern in our folder),
  never other files; deletes that are refused are warnings, not failures; pruned rows keep `offsite_at` (copied once) but
  lose `offsite_key`, so they are not queued again. (5) `fetch` brings a copy back through `importUpload` (an uploaded
  backup, checked like any upload) and only for keys that match the pattern. The copy is NOT re-encrypted: it holds
  everything a download holds. Tests: `backup-offsite.test.ts` (pure), `backup-offsite.integration.test.ts` (run on
  CockroachDB and YugabyteDB), smoke "offsite" tests, the Offsite tab in `backups.spec.ts`; the real round trip was run
  against a second Garage bucket.
- **Stored backups are re-read and checked** (`backup/verify.service.ts`, `backup-verify.ts`, migration 0069
  `backups.verified_at/verify_error/verify_tried_at`, rules in `packages/shared/src/backup-verify.ts`, unit-tested). Job
  `backup-verify` (10 min) checks the newest `VERIFY_RECENT` ready backups once and the newest again every
  `VERIFY_RECHECK_DAYS`; a failed one retries after `VERIFY_RETRY_MINUTES`. It runs as a `verify` operation under the ordinary
  operation lease (so it excludes restores and deletes of that file), reads only, and judges: size and SHA-256 recorded at
  write time (hash the whole stored file: drain the stream after the tar ends), `inspectArchive` (counts, file checksums),
  and `ContentChecker` (keys present and unique, required columns filled, every foreign key's parent in the archive; a backup
  is one serializable snapshot so a dangling link means a wrong file). Failure: one `backup.failed` notice, the Security
  overview (`judgeVerification`: newest failing = critical). **This proves a file is whole, not that it restores**: the
  restore rehearsal does (`tests/cluster/verify-restore.sh` / `make verify-restore`: restores a real backup of the dev
  stack into the throwaway cluster, then compares EVERY node with the file via `dist/scripts/rehearse-restore.js diff`,
  the app's own `computeDiff`; it cannot rely on signing in afterwards because a restore of a foreign backup replaces the
  asking account). Integration test: the "stored backup of real data" case in `backup.integration.test.ts`.
- **Object store**: use `removeObject` per key. minio's `removeObjects` is refused by Garage ("Invalid
  delete XML query"), and swallowing delete errors had leaked archives; `removeBackup` keeps the row when
  the delete fails and `sweepOrphans` cleans up archives with no row.
- **Downloads are two steps** (an audited POST makes an HMAC-signed link, then a GET): the token is a
  query parameter because Fastify drops path parameters longer than 100 characters (404). Uploads use
  `req.file({ limits })` to lift the global 10 MiB multipart cap.
- **Never restore in the smoke or e2e suites against the live stack** (it rewinds data the rest of the
  suite uses). Restores are tested by `apps/api/test/backup.integration.test.ts` (run it on CockroachDB
  and YugabyteDB with `TEST_DATABASE_URL`), `backup.scale.test.ts` (`BACKUP_SCALE=1`) and
  `tests/cluster/backup-restore.sh` on the throwaway cluster.

## Upgrading a deployment (`scripts/upgrade.sh`)

`scripts/upgrade.sh` (operator docs: INSTALL.md "Upgrading"; test: `tests/upgrade/upgrade.sh`, a fake compose in throwaway
git repos) upgrades the node it runs on. The order is the contract: look (fetch, plan, refuse a dirty tree) -> backup
(single node, bundled database) -> build the new images while the old containers keep serving -> migrate with the NEW
image in a one-off container -> swap only `api web monitor` (`up -d --no-build --no-deps`; everything, plus a proxy restart,
only when `infra/` changed; in a cluster `cluster.sh drain` before and `undrain` after the node is healthy) -> verify
inside the containers (`/readyz`, web answering, `BUILD_ID` of api and web equals `scripts/build-id.sh`) -> otherwise
roll back by itself. A failed build or migration puts the code back before anything was swapped. Rules:
- **Do not skip rebuilding a service because its sources did not change.** `BUILD_ID` is baked into every image and every
  node of a cluster must run the same build; Docker's layer cache already makes the unchanged parts cheap.
- **Migrations are never undone by a rollback**: that is only safe because they are additive (expand/contract), which is the
  existing migration rule; a destructive migration breaks `--rollback` and the automatic one.
- **`scripts/upgrade-cluster.sh` upgrades all nodes** by running `upgrade.sh` on each in turn (local, or over key-only SSH
  as a detached job whose log it follows, so a dropped session does not stop an upgrade halfway). Node list:
  `data/upgrade/nodes` (`local` | `[user@]host[:port] [folder]`), else `CLUSTER_PEERS`. One commit for every node
  (resolved once, `--to <sha>`), a node must answer `/healthz` 200 before the next starts, `NODE_ROLE=data` nodes are
  skipped, and it STOPS at the first failure (that node rolled itself back; later nodes untouched). It runs from a
  copy of itself because upgrading the local node replaces its own file. Test: `tests/upgrade/upgrade-cluster.sh`
  (fake ssh/curl and a stub `upgrade.sh`; the real SSH path was also run against an sshd container).
- **Never swap the database or object store from here** (a cluster node's database restarting is not an upgrade step).
- It cannot run on the dev host's prod stack for the same reason nothing else can (shared `./data`): test with the fake
  harness, and `--dev` on the dev stack.

## Containers and the page policy

- The api, web and monitor images run as the unprivileged `node` user on `node:22-alpine`. Nothing writes under `/app`
  except the web's `.next/cache`. The IPAM/monitor ping works unprivileged through Docker's default
  `net.ipv4.ping_group_range`; `NET_RAW` stays in compose for runtimes that restrict that. A new feature that
  writes to the container filesystem must use `/tmp`, an S3 key or the database.
- **Content-Security-Policy:** `apps/web/src/middleware.ts` gives every page a per-request script nonce
  (`script-src 'nonce-...' 'strict-dynamic'`, no `unsafe-eval`) and Next applies it to its scripts; the layout hands it
  to the theme bootstrap. Caddy sends a looser baseline on every response as well (the browser enforces both). **A new
  inline `<script>` must take the nonce** (read `x-nonce` from `headers()`); the smoke suite fails on a bare one.
  Styles stay `unsafe-inline`.
- `/api/v1/auth/providers/internal`, `/users/ensure-default-group` and `/users/oauth-provision` are 404 at the proxy
  (and token-gated in the api); a new internal-only route belongs in Caddy's `@internal_only` matcher too.

## Retention

Tables that only grow are pruned by age, in batches (`retention/batched-delete.ts`: portable `WHERE pk IN (SELECT pk ...
LIMIT n)` loops, capped per run), by cluster jobs, each window a setting where 0 keeps everything: audit log
(`audit.retention_days`, 365, in `AuditService`), notifications (`notifications.retention_days`, 180) and the activity
feed (`activity.retention_days`, 90), the last two in `RetentionService`. A new table that grows without bound needs a
window here (or in its own service, as infra metrics and mail do), not a one-off `DELETE`. Test:
`apps/api/test/retention.integration.test.ts`.

Emails are stored lower-case and "already in use" ignores case (admin create and `PATCH /me`): sign-in lower-cases what
is typed, so a mixed-case row could never be matched.

## Repository hygiene

- **`.gitignore` entries for root folders are anchored** (`/backups/`, `/data/`, `/secrets/`). Unanchored, `backups/` hid
  the whole admin Backups page (`apps/web/src/app/admin/backups/`) and the Cisco backups page: they worked on the machine
  that wrote them and were missing from every clone (a fresh install's `/admin/backups` was a 404). `make check-repo`
  (`scripts/check-ignored.sh`, also run by `tests/installer/dry-run.sh`) fails if any source file is ignored. Before saying a
  feature is pushed, `git status` must show it tracked; tests run on a working copy do not prove a fresh clone has it.

## Conventions

- **Type-safe everywhere.** No `any` in committed code. Use Zod schemas from
  `packages/shared` for request/response validation on both sides.
- **Portable SQL only: it must run on CockroachDB *and* YugabyteDB.** See
  ## Database for the specific traps (no LISTEN/NOTIFY, no row-level TTL, no
  `DELETE … LIMIT`, no DO blocks). Prefer Drizzle helpers.
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
# dev stack (bundled Cockroach single node unless DB_MODE=external). No bundled
# mail sink — configure SMTP in /admin/settings (or leave blank to disable email).
# Every compose call goes through scripts/compose.sh (applies DB_MODE).
pnpm dev:up               # scripts/compose.sh up -d --build
pnpm dev:down             # stop + remove
pnpm dev:logs             # tail all services
pnpm dev:psql             # SQL shell (cockroach sql, or psql for an external DB)

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
- **Phase 3 — mostly done** — Meilisearch across wiki/notes/tickets **and all monitoring data points** (monitors, infra, UniFi devices/clients, Cisco switches/ports/MAC/ARP/VLAN — see ## Search), @mentions, tags, activity feed, saved views, checklists. **AI/LLM/MCP module: started** — an MCP server with wiki tools (see ## MCP server).
- **Assistant (chatbot) — designed, not built** — an in-app chat over wiki, tickets and live data, using an *external* LLM (Claude API or any OpenAI-compatible endpoint the admin supplies), disabled by default until an admin configures and enables it. Full design, requirements and phasing in [docs/assistant.md](docs/assistant.md); do not start building without an explicit ask.
- **Service monitoring templates — designed, not built** — in-depth per-service monitoring on infra hosts (HAProxy, databases, Kea, Technitium ...) driven by a declarative, GUI-editable template engine. Design, proposed decisions and phasing in [docs/service-monitoring.md](docs/service-monitoring.md); do not start building without an explicit ask.
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
convenience when the bundled database runs, bound to `127.0.0.1` only because the
insecure-mode UI has no login (reach it over an SSH tunnel). Both are env-overridable.
`scripts/compose.sh` passes `--env-file .env`, so the root `.env` feeds the `${VAR}`
interpolation in both compose files (compose would otherwise look in `infra/`).

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
  The user is reset with `must_change_password=true`: the smoke suite asserts
  the gate blocks writes, then changes the password itself; `make regression`
  resets the user again before e2e, which tests the browser change-password
  flow. Smoke tests that touch optional integrations (UniFi, ProPresenter,
  DNS) branch on whether they're configured, and never send live commands
  (e.g. ProPresenter "next") to a configured device.
- **API rate limit:** `auth.rate_limit_per_minute` (default 1200, floor 60) is
  read live by @fastify/rate-limit; sign-in/TOTP/password-change have a fixed
  10/min bucket. The smoke client waits out 429s via `retry-after`.
- **Configuration:** anything an operator might want to change at runtime (Google OAuth
  client, SMTP, site name, etc.) lives in the `settings` table and is editable at
  `/admin/settings`. Only true bootstrap values (DB URL, `AUTH_SECRET`, `APP_URL`)
  stay in `.env`. `KNOWN_SETTINGS` in `packages/shared/src/settings.ts`
  is the catalogue.
- **Volumes:** all stateful services bind-mount into `./data/<service>/` at the repo
  root. Backup = `tar -czf data/`. `make init-data` creates the dirs with the right
  perms (Meilisearch needs a world-writable dir).

## Things to never do

- Restore a backup in a test against the live dev stack (use the throwaway cluster)
- Start the production compose stack from this checkout on the dev host (it shares `./data` with the
  live dev stack): use `tests/cluster/sim.sh`
- Add `tenant_id` columns
- Bypass the audit interceptor
- Set HTTPS/HSTS/TLS config inside the app (it's offloaded upstream)
- Expose any service besides Caddy to the host
- Hard-code role/group names in business logic (guard on permission strings derived from module tiers), or read the legacy `roles`/`permissions`/`role_permissions`/`group_permissions` tables
- Use SQL that only one of CockroachDB / YugabyteDB accepts
- Add Phase 4 church-specific modules without an explicit user ask
- Commit emojis in code or generated files
- Re-introduce env-based config for things in `KNOWN_SETTINGS` — they belong in the DB
- Add a bare `setInterval`/`setTimeout` loop for work that must not run twice at once — use `ClusterJobs` (see ## Cluster coordination)
