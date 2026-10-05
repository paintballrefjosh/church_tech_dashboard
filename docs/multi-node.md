# Multi-node deployment: design and work plan

Status: **all eight phases are implemented and tested.** Shape C (bundled database on every node) has run on a simulated three-node cluster and shape D (your own database and object store) as two nodes behind a load balancer, on CockroachDB and on YugabyteDB, with the smoke and browser suites passing through the balancer. Everything ran on one host: no real network between nodes was tried.
Written 2026-10-04. When a phase ships, tick it in [Phases](#phases) and make sure
INSTALL.md and CLAUDE.md describe what actually exists. Items marked **(done)** below are
in the code; see [Phase 0 notes](#phase-0-notes), [Phase 1 notes](#phase-1-notes), [Phase 2 notes](#phase-2-notes), [Phase 3 notes](#phase-3-notes), [Phase 4 notes](#phase-4-notes), [Phase 5 notes](#phase-5-notes), [Phase 6 notes](#phase-6-notes), [Phase 7 notes](#phase-7-notes) and [Phase 8 notes](#phase-8-notes).

## Goal

Four supported deployment shapes, chosen by configuration, not by forking compose files:

| | Bundled DB | Remote DB |
|---|---|---|
| **Single node** | A. one host runs everything, including a single-node CockroachDB | B. one host runs the app, you run the DB |
| **Multi node** (2+) | C. every node runs the full stack including a local CockroachDB; the databases form one cluster | D. every node runs the app, you run the DB cluster |

For both multi-node shapes:

- An **upstream load balancer outside this project** spreads traffic over the nodes. Any
  node's web front end and API can serve any read or write. No sticky sessions.
- **Nodes are peers.** No fixed primary node. Work that must happen once (pollers,
  schedulers) is shared out through database leases, so losing any node moves its work to
  another one within about 30 seconds.
- **The database is the only shared state the app itself relies on.** Redis goes away.
  Search is per node and derived from the database. Uploaded files live in an S3-compatible
  store.

Decisions already made (2026-10-04):

1. **Redis is removed in every mode, not just multi-node.** Realtime fan-out and the mail
   queue move to the database. (Alternatives considered: Redis + Sentinel, one shared
   Redis. Rejected: more to run, and in shape D it would be a second remote service the
   operator has to provide.)
2. **The bundled object store is Garage, for single node and multi node alike** (decided 2026-10-04,
   after the original choice of "Garage for multi-node, MinIO for single node" became unworkable:
   the MinIO images are no longer published, see the Phase 5 and 6 notes). External S3 works in every
   shape.
3. **Bundled multi-node CockroachDB runs in secure mode** with generated certificates,
   because its port has to be published on the host network.

## What the code assumes today

Everything below was checked against the code on 2026-10-04.

- **13 modules start their own timers in the API process** with no coordination (list in
  [Singleton jobs](#singleton-jobs)). Two API instances would double-poll, double-alert and
  race on DNS writes.
- **Realtime and mail depend on one Redis** (`realtime/redis-io-adapter.ts`,
  `mailer/mail-queue.ts` using BullMQ). The Socket.IO adapter falls back to in-memory if
  Redis is down at boot, so a multi-node cluster would silently lose cross-node events.
- **`RealtimeGateway.roomSize()` is local only** (`realtime.gateway.ts:189`). The UniFi
  poller skips its work when no browser is connected to *its* node
  (`unifi.poller.ts:60`), so a viewer on another node would see a frozen page.
- **Meilisearch has no clustering.** Content documents are upserted by whichever node
  handled the write, and the UniFi and DNS documents are pushed only by the node running
  the poller or indexer, so each node's index would hold a different subset.
- **Per-process caches**: user/permission cache 30s (`auth.service.ts:38`), settings
  cache 60s (`settings.service.ts:22`). A permission change or revoked access would take up
  to a minute to reach other nodes.
- **Rate limits are counted per process.** The 10/min sign-in bucket becomes 10 x N/min.
- **The `monitor` worker** selects due monitors and probes them with an in-memory
  `inFlight` set (`services/monitor/src/main.ts`). Two workers probe everything twice.
- **Socket.IO offers `polling` as well as `websocket`** (gateway plus three clients).
  Polling needs sticky sessions on a load balancer.
- **Next.js build identity**: the sign-in page uses Server Actions, so each node's build
  generates its own action encryption key and build ID. Requests that cross nodes fail.
- **Caddy trusts `X-Forwarded-For` from everywhere** (`trusted_proxies static 0.0.0.0/0`),
  so the client IP used for audit rows and rate limits can be spoofed once an external load
  balancer is in front.
- **No database connection resilience.** There are 7 `new Pool(...)` sites and none
  registers `pool.on("error")` (an idle connection error is an unhandled event and can
  crash the process when a DB node dies). Nothing retries a transient failure.
- **Migrations** run once by hand (`make migrate`). Nothing prevents two nodes running
  them at once, and nothing guarantees that a new schema works with the previous release
  during a rolling upgrade.
- **Object storage is fine for Garage**: the attachments code only uses `putObject`,
  `getObject`, `removeObject`, `bucketExists`, `makeBucket`.

## Architecture per shape

Each node runs: `proxy` (Caddy), `web`, `api`, `monitor`, `meilisearch`. Beyond that:

| Service | A | B | C | D |
|---|---|---|---|---|
| CockroachDB | 1 local node | external | local node, clustered across hosts | external |
| Object store | Garage (1 node) | Garage (1 node) or external S3 | Garage, clustered across hosts (or external S3) | external S3 (or Garage) |
| Redis | none | none | none | none |
| Meilisearch | local | local | local, one per node, independent | local, one per node, independent |
| Leases / coordination | trivially always leader | same | DB-backed | DB-backed |

Settings that choose the shape (all bootstrap values in `.env`, per node):

| Variable | Meaning |
|---|---|
| `DEPLOY_MODE` | `single` (default) or `cluster` |
| `DB_MODE` | `bundled` (default) or `external`, as today |
| `S3_MODE` | `bundled` (default) or `external` |
| `NODE_ID` | stable identifier for this node (default: hostname) |
| `NODE_ROLE` | `full` (default) or `data` (witness: runs only the database and object store, no app) |
| `NODE_ADDR` | address other nodes use to reach this one (cluster only) |
| `CLUSTER_PEERS` | comma-separated `NODE_ADDR`s of the other nodes (cluster only) |
| `CLUSTER_BIND_ADDR` | host interface to publish cluster ports on (cluster only) |
| `BACKGROUND_JOBS` | `on` (default) or `off`: keep this node from taking pollers, for nodes that cannot reach monitored devices |
| `TRUSTED_PROXIES` | CIDRs of the external load balancer, for Caddy |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `BUILD_ID` | must be identical on every node |
| `AUTH_SECRET` | must be identical on every node (already true for single node) |

### Node counts and what they survive

A database cluster needs a majority to stay up. This decides what "2, 3 or more nodes"
actually buys:

| Nodes | Database | Object store | Practical meaning |
|---|---|---|---|
| 2 | **No failover.** Losing either node stops writes | No failover for writes | Two web front ends for capacity and rolling upgrades, not availability |
| 2 + a `data` witness | Survives one node | Survives one node | The cheapest real HA: a third small host that only runs the DB and object store |
| 3+ | Survives one node (two if 5+) | Survives one node | Full HA |

Garage's replication factor is fixed when the cluster is created (2 for two nodes, 3 for
three or more), so decide the node count before first start. Adding nodes later is
supported by the database but needs a Garage re-layout.

## Work breakdown

Size: S = under a day, M = a few days, L = about a week or more. File paths are where the
change lands today.

### 1. Coordination foundation (new)

| # | Change | Size |
|---|---|---|
| 1.1 **(done)** | Migration `0050`: `cluster_nodes` (id, addr, role, version, last_seen), `cluster_leases` (name, holder, epoch, expires_at), `job_state` (job, key, value jsonb). Plain portable SQL, `IF NOT EXISTS`, tested fresh on Cockroach and Yugabyte. | S |
| 1.2 **(done)** | `apps/api/src/cluster/`: `NodeService` (identity from `NODE_ID`, heartbeat every 10s), `LeaseService` (acquire/renew with `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now()`, **database clock** not node clock, 30s TTL renewed every 10s, epoch for fencing). Verified on Cockroach 24.2 and YugabyteDB 2024.2 (YB 2026.1 not yet). | M |
| 1.3 **(done)** | `ClusterJobs` runner: `register({ name, everyMs, run, ... })`; runs `run` only while this node holds the `job:<name>` lease. One lease per job, so a failed node's jobs move individually. No load balancing: whichever node claims first keeps a job, which is fine at this scale. Honours `BACKGROUND_JOBS=off`. | M |
| 1.4 **(done)** | Convert every singleton job to the runner (table below). On a single node the node always wins, so behaviour is unchanged. | M |
| 1.5 **(done)** | Move in-memory alert baselines into `job_state` so a new leader does not re-alert or miss a transition: UniFi `deviceStates`, DNS health `failures`/`alerted`. Infra threshold state is already in the DB. | S |

#### Singleton jobs

| Job | File | In-memory state to handle |
|---|---|---|
| UniFi poller | `unifi/unifi.poller.ts` | `deviceStates` (alert baseline) -> `job_state`; `roomSize()` check -> presence (2.3) |
| Cisco poller | `cisco/cisco.poller.ts` | `inFlight` set: fine under one leader |
| Infra collector (tick, rollup, prune) | `infra/infra-collector.ts` | `prev` map for counter deltas: losing it on failover costs one sample, acceptable |
| Infra updater | `infra/infra-updater.ts` | check at implementation |
| Printers poller | `printers/printers.service.ts` | none |
| UPS poller | `ups/ups.service.ts` | none |
| IPAM scanner and `syncLabels` | `ipam/ipam.scanner.ts` | needs `NET_RAW` on every node's `api` (already in compose) |
| DNS sync | `dns/dns.sync.ts:219` | replace the in-process `running` guard with the lease |
| DNS health | `dns/dns.health.ts` | `failures`, `alerted` -> `job_state` |
| DNS search indexer | `dns/dns.search-indexer.ts` | becomes a producer of `live_search_docs` (section 3) |
| Checklist scheduler | `checklists/checklist.scheduler.ts` | already idempotent; lease anyway |
| Audit prune | `audit/audit.service.ts` | none |
| Monitor worker | `services/monitor/src/main.ts` | per-monitor claim, not a lease (1.6) |
| Search monitoring sync | `search/search.service.ts:161` | **runs on every node, not under a lease**: each node rebuilds its own local index from the DB |

| # | Change | Size |
|---|---|---|
| 1.6 **(done)** | `monitor` worker: add `monitors.claimed_until`; claim a due monitor with a single conditional `UPDATE ... RETURNING` before probing so all nodes' workers share the load and none double-probes. Prune under a lease. A node that dies mid-probe delays that check by one claim window. | M |
| 1.7 **(done, rule in CLAUDE.md)** | Migrations: `migrate.js` takes a `migrate` lease row so two nodes cannot run it at once. Add the **expand/contract rule** to CLAUDE.md: migration N must work with release N-1 because nodes upgrade one at a time. Destructive changes ship in two releases. | S |

### 2. Replace Redis with the database

| # | Change | Size |
|---|---|---|
| 2.1 **(done)** | **Realtime events table** `realtime_events` (id, origin_node, room, event, payload, ts). `RealtimeGateway.emit*` delivers to local sockets immediately and inserts a row; each node polls about once a second for rows from other nodes (cursor on `ts` with a few seconds of overlap, dedupe by id) and emits them to its own sockets. Prune rows older than 60s. Delete `redis-io-adapter.ts` and the `@socket.io/redis-adapter` dependency. Cross-node latency becomes up to about 1s. | L |
| 2.2 **(done)** | **Large payloads stay out of the events table.** `network:snapshot` carries every UniFi device and client each poll. Store it once in `live_snapshots` (kind, payload, updated_at, upsert) and send an event that only says it changed; each node reads the row and pushes it to its local sockets. The same row feeds search (section 3). | M |
| 2.3 **(done)** | **Cluster-wide presence** `realtime_presence` (node, room, count, updated_at, heartbeat 5s) replaces `roomSize()`. `hasViewers(room)` becomes async and reads it. Fixes `unifi.poller.ts:60`. | M |
| 2.4 **(done)** | **Cache invalidation over the same channel.** `invalidateUser(id)` / settings writes publish `cache.invalidate` events so other nodes drop their `userCache` / settings cache within about a second instead of 30-60s. Matters for access revocation. | S |
| 2.5 **(done)** | **Mail outbox** `mail_outbox` (id, message, attempts, next_attempt_at, claimed_until, status, last_error). Each node runs a claim loop (single-statement claim with retry on 40001; no `SKIP LOCKED`, which is not portable across both engines). Same policy as today: 5 attempts, exponential backoff from 5s, prune failed after 24h. Replaces `mailer/mail-queue.ts`; removes `bullmq` and `ioredis`. | M |
| 2.6 **(done)** | **Strict rate-limit bucket in the DB.** Custom `@fastify/rate-limit` store for the 10/min sign-in, TOTP and password-change bucket so brute-force protection does not scale with node count. The global bucket stays per node and is documented as x N. | S |
| 2.7 **(done)** | Remove Redis everywhere: both compose files, `.env.example` (`REDIS_URL`), `./data/redis`, `init-data`, `check-ports`, health checks, docs. Ships with phase 2 so all modes move together. | S |

### 3. Search per node, derived from the database

Meilisearch stays one instance per node. Nothing is shared and nothing is clustered; every
node's index is rebuilt from, and kept in sync with, the database.

| # | Change | Size |
|---|---|---|
| 3.1 **(done)** | **Search outbox** `search_outbox` (seq, kind, resource_id, op, ts). Services that call `search.upsert/remove` (tickets, notes, wiki) append a row instead; the node that handled the write also applies it locally right away. A `SearchSync` loop on every node tails the outbox and applies rows to its local index by rebuilding the document **from the DB** (so permissions and content are never stale). Prune after 24h. | L |
| 3.2 **(done)** | Refactor document building into `buildDoc(kind, id)` for all DB-backed kinds (the monitoring kinds already have `buildMonitoringDbDocs`). | M |
| 3.3 **(done)** | **Live (non-DB) kinds go through `live_search_docs`** (kind, doc_id, payload) written by the single poller or indexer holding the lease: UniFi devices and clients (from the same snapshot as 2.2), DNS records. Every node reconciles its local index from the table by kind. This avoids every node polling the UniFi controller and Technitium. | M |
| 3.4 **(done)** | A new or restarted node does a full reconcile from the DB before it starts answering search. | S |
| 3.5 **(done)** | Admin **Reindex** acts on the local node by default; add "all nodes" via a counter row each node watches. | S |

Consequence to document: search is **eventually consistent across nodes** (about 1-2s).
A ticket created on node A can be missing from a search served by node B for a moment.

### 4. Database layer hardening (needed by every multi-node shape, and by remote single-node)

| # | Change | Size |
|---|---|---|
| 4.1 **(done)** | One shared pool factory used by all 7 `new Pool` sites (`db/db.module.ts`, `web/src/lib/db.ts`, `services/monitor/src/db.ts`, and the five scripts), with `pool.on("error")` handlers, sensible `connectionTimeoutMillis`, `idleTimeoutMillis`, `keepAlive`, and TLS options from env. | M |
| 4.2 **(done)** | Retry transient failures: serializable-retry (SQLSTATE 40001) and connection resets on idempotent reads and on write paths that are safe to repeat. Decide the scope after an audit; at minimum the lease, outbox and event loops must retry. | M |
| 4.3 **(done)** | TLS: verify how `pg` 8.13 treats `sslrootcert` in the URL. If it does not load the file, read the CA from an env path in the shared factory. Needed for `sslmode=verify-full` against the secure bundled cluster and most remote clusters. | S |
| 4.4 **(done)** | Chaos test: stop a DB node under load and confirm the app recovers without a restart. | M |

### 5. Web tier and proxy

| # | Change | Size |
|---|---|---|
| 5.1 **(done)** | **WebSocket-only Socket.IO**: `transports: ["websocket"]` in the gateway and the three clients (`use-realtime.ts`, `user-menu.tsx`, `pending-client.tsx`). Removes the need for sticky sessions. The upstream load balancer must pass WebSocket upgrades. | S |
| 5.2 **(done)** | **Identical Next.js builds across nodes**: set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (generated once, same in every `.env`), `generateBuildId` from `BUILD_ID`, and `deploymentId` for skew protection. Support pulling prebuilt images (`API_IMAGE`, `WEB_IMAGE`, `MONITOR_IMAGE`) so a release is built once and run everywhere; per-node build from the same commit stays as the fallback. | M |
| 5.3 **(done)** | **Caddy behind an external LB**: `TRUSTED_PROXIES` replaces `0.0.0.0/0`, so `{client_ip}` is the real client for audit rows and rate limits. Keep the `header_up` rules. | S |
| 5.4 **(done)** | **Load balancer health and drain**: a `/healthz` on Caddy that is 200 only when this node's API and its database connection are healthy, and 503 while a drain flag file exists (`scripts/cluster.sh drain`) so an operator can take a node out before upgrading it. | S |
| 5.5 **(done)** | Confirm Auth.js needs nothing else per node: JWT is stateless; providers and secrets are in the DB; `AUTH_SECRET` must match. | S |

### 6. Object storage

| # | Change | Size |
|---|---|---|
| 6.1 **(done)** | Rename `MINIO_*` to `S3_*` (`S3_ENDPOINT`, `S3_USE_SSL`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) with the old names still read; add path-style addressing. Update `attachments/minio.client.ts` and `health.controller.ts`. | S |
| 6.2 **(done, with phase 7)** | Garage service for `DEPLOY_MODE=cluster, S3_MODE=bundled`: generated `garage.toml` per node (shared `rpc_secret`, `rpc_public_addr`, bootstrap peers), RPC port published on `CLUSTER_BIND_ADDR`, the S3 port kept on the internal network, an init step that assigns the layout, creates the bucket and an access key (replacing `minio-init`). | L |
| 6.3 **(done)** | A data-copy path for moving an existing single-node install's files from MinIO into Garage or external S3 (`mc mirror`). | S |
| 6.4 **(done)** | **Backups in cluster mode**: `db-backup` writes to an S3 bucket (Cockroach `BACKUP` accepts an S3 URI with a custom endpoint) instead of node-local files, so any node can restore it. External-DB installs keep doing their own backups. | M |

### 7. Bundled multi-node database (shape C only)

| # | Change | Size |
|---|---|---|
| 7.1 **(done)** | `infra/docker-compose.cluster.yml` (+ `cluster-db.yml`, `cluster-s3-api.yml`): one `cockroach` service per node in **secure mode** (`--certs-dir`, `--advertise-addr=$NODE_ADDR`, `--join=$CLUSTER_PEERS`), the inter-node and SQL port published on `CLUSTER_BIND_ADDR`, local `DATABASE_URL` pointing at the node's own instance with `sslmode=verify-full`. `NODE_ROLE=data` runs only database plus object store. | L |
| 7.2 **(done)** | `scripts/cluster.sh`: `init-certs` (CA plus per-node certs, SQL user and password), `init` (first node only: `cockroach init`, create database and app user), `join`, `status`, `drain`, `remove-node` (decommission). | L |
| 7.3 **(done)** | `scripts/compose.sh` and `check-ports.sh` understand `DEPLOY_MODE`, `S3_MODE`, `NODE_*`, reject impossible combinations, and allow the cluster ports only in cluster mode. | M |
| 7.4 **(done)** | Documented certificate rotation and a documented procedure for replacing a lost node. | M |
| 7.5 **(done, documented; the conversion as a whole is not run on a real install)** | Converting an existing install to a cluster is **not in place**. The bundled DB changes from insecure to secure, so the path is: back up, start a fresh cluster, restore, copy files. Document it. | S |

### 8. Visibility, tests, docs

| # | Change | Size |
|---|---|---|
| 8.1 **(done)** | Admin **Cluster** page (and a Monitoring tile): nodes with last heartbeat, version, role; which node holds each job lease; DB engine and node count; object-store layout status. An alert when a node's heartbeat goes stale, raised by the other nodes. | M |
| 8.2 **(done)** | **Two-node test harness**: two compose projects on one host with different ports, a small Caddy as the "external load balancer", the smoke suite run through it, plus a read-after-write check across nodes. | L |
| 8.3 **(done across phases 0-8)** | Unit tests: lease contention, expiry takeover and fencing; outbox claim races; realtime dedupe and ordering; cache invalidation. | M |
| 8.4 **(done across phases 3-8)** | Failure tests: stop a node and check jobs move within one lease TTL, no mail is sent twice, realtime keeps reaching clients on the surviving node, search converges. | M |
| 8.5 **(done)** | Regression: the full existing suite passes in shape A after Redis removal, and fresh installs on Cockroach and Yugabyte pass for every new migration. | M |
| 8.6 **(done)** | Documentation: INSTALL.md (already drafted for the target shapes, see below), CLAUDE.md, `.env.example`. CLAUDE.md changes: Redis removed from the architecture diagram and stack table; the "single port 8100" and "expose nothing but Caddy" rules gain an explicit cluster-mode exception; a new rule that **no new in-process timers or in-memory shared state**, use `ClusterJobs` and the DB; the expand/contract migration rule. | M |

## Phases

Order matters. Each phase leaves shape A working and shippable.

- [x] **0. Foundation** (1.1-1.5, 1.7): lease service, job runner, convert all jobs. No behaviour change on a single node. Done 2026-10-04, see [Phase 0 notes](#phase-0-notes).
- [x] **1. Redis out** (2.1-2.7): realtime events, presence, cache invalidation, mail outbox, rate-limit store. Affects every shape. Done 2026-10-04, see [Phase 1 notes](#phase-1-notes).
- [x] **2. Search per node** (3.1-3.5). Done 2026-10-04, see [Phase 2 notes](#phase-2-notes).
- [x] **3. Monitor worker and DB hardening** (1.6, 4.1-4.4). Done 2026-10-04, see [Phase 3 notes](#phase-3-notes).
- [x] **4. Web tier** (5.1-5.5). Done 2026-10-04, see [Phase 4 notes](#phase-4-notes).
- [x] **5. Object store** (6.1, 6.3, 6.4 partly): enough for external S3. Done 2026-10-04, see [Phase 5 notes](#phase-5-notes).

**Milestone M1: shape D works** (multi-node with a remote DB and external S3) after phases 0-5. Reached: proven in phase 8.

- [x] **6. Garage** (6.2): single node in phase 6, clustered with phase 7. Done 2026-10-04, see [Phase 6 notes](#phase-6-notes) and [Phase 7 notes](#phase-7-notes).
- [x] **7. Bundled cluster** (7.1-7.5). Done 2026-10-04, see [Phase 7 notes](#phase-7-notes).
- [x] **8. Visibility, harness, docs** (8.1-8.6). Done 2026-10-05, see [Phase 8 notes](#phase-8-notes).

**Milestone M2: shape C works** after phases 6-8. Reached.

Phases 1, 2 and 3 can run in parallel after phase 0.

## Phase 0 notes

What was built and how it behaves. Code is in `apps/api/src/cluster/`.

- **Identity** (`node-identity.ts`, `NodeService`): `NODE_ID` (default hostname; the dev and
  prod compose files default it to `main` so it survives container recreation),
  `NODE_ROLE`, `NODE_ADDR`, `BACKGROUND_JOBS`. A heartbeat row in `cluster_nodes` every 10s;
  rows unseen for an hour are pruned by whichever node notices.
- **Leases** (`lease.store.ts`, `LeaseService`): one `INSERT ... ON CONFLICT DO UPDATE ...
  WHERE ... RETURNING` per acquire or renew, judged by the database clock. Job leases last
  30s and are renewed every 10s, so after a crash another node takes a job over within about
  30-40s; a clean shutdown releases them at once. Mutexes (`acquireMutex`, `withMutex`) have
  a distinct holder per acquisition, so they exclude a second caller in the same process too.
- **Jobs** (`ClusterJobs`): every node runs every timer; a firing only does work while this
  node leads that job. Leadership is judged against a local monotonic clock, ending 2s before
  the lease could lapse, so a stalled node stops before another starts. `fixed-rate` (the
  `setInterval` behaviour, runs may overlap) and `fixed-delay` (the self-rescheduling
  `setTimeout` behaviour) are both supported. 15 jobs: `audit-prune`,
  `checklist-generate`, `cisco-poll`, `dns-health`, `dns-search-index`, `dns-sync`,
  `infra-prune`, `infra-rollup`, `infra-tick`, `infra-update-reconcile`, `ipam-scan`,
  `printers-poll`, `ups-poll`, `unifi-poll`. A fresh install logs one warning per job until
  migrations are applied, then the jobs start.
- **Persisted job state**: the UniFi alert baseline is read from `job_state` on every pass (so
  a new leader alerts on a device that went offline during the handover, and a node that
  regains leadership does not use a stale in-memory copy; a baseline older than 5 minutes is
  ignored). The DNS health failure counter and "alerted" flag are persisted the same way.
- **DNS sync** takes the `dns-sync` mutex for every run from any node and trigger, replacing
  the in-process `running` guard, and stops mid-run if the mutex is lost.
- **Infra update runs** now record `node_id`. The old boot-time "fail every running row"
  would have failed an update another node was still running. Now a booting node fails only
  its own and pre-cluster rows; the `infra-update-reconcile` job fails rows whose node has
  stopped heartbeating.
- **Migrations** hold the `migrate` lease for the whole run; a second runner waits, then
  finds nothing to apply. The lease table is created by the script itself first, because
  migration 0050 creates it too.
- **Shutdown hooks are now enabled** in `main.ts` (they were not, so no `onModuleDestroy` ever
  ran on SIGTERM). The database pool now closes in `onApplicationShutdown`, after every
  module's `onModuleDestroy`, so those hooks can still use the database.
- **Not done, by design**: the `monitor` worker claim (1.6) is phase 3; `roomSize()` and the
  per-node caches are phase 1; per-node search is phase 2. Until those land, running a second
  node is still unsupported.

Verified: type check and 51 unit tests (14 new, for leases and the job runner, with an
in-memory store and fake timers); fresh `migrate` on CockroachDB 24.2 and YugabyteDB
2024.2.3; two migrators started at once on CockroachDB (one waited, 51 migrations applied
once); the dev stack rebuilt with all 15 jobs leading, a clean restart releasing every
lease and the node row, and the full smoke suite (171 passed, 0 failed).

## Phase 1 notes

Redis is gone from the code, both compose files, `.env.example`, the Makefile and the
lockfile (`bullmq`, `ioredis`, `@socket.io/redis-adapter` removed). Each piece is in
`apps/api/src/cluster/` or `apps/api/src/mailer/`, with a store interface so the logic is
unit-tested without a database and the SQL is tested on real engines.

- **Event bus** (`ClusterBus`, `realtime_events`): a node delivers to its own sockets at once and
  publishes batched rows; every node polls about once a second for other nodes' rows and
  never receives its own. Order is (ts, origin, seq). A poll looks back 5s to catch a late
  commit and drops duplicates by id, but never reaches back past the node's own start, so a
  restarted node does not replay recent events to browsers that just reconnected. A full page
  continues exactly where it ended. Events over 512 KB are not sent (logged); rows are
  pruned after 60s by a cluster job. Measured on two real nodes: 0.85s across nodes.
- **Presence** (`realtime_presence`): a node writes the sizes of the rooms a client can
  subscribe to every 5s and within 250ms of any subscribe or disconnect; rows unrefreshed
  for 20s are ignored. `RealtimeGateway.hasViewers(room)` is local or remote.
  `roomSize()` is gone. Resource-room events are sent to the bus only while another node has a
  viewer; `user:*` events always go out.
- **Snapshots** (`live_snapshots`): the UniFi network snapshot is stored once and the event
  carries a pointer; the receiving node reads it and emits the full payload. Measured: the
  viewer on node 2 got a full snapshot from the poller on node 1 in about 2.7s.
- **Cache invalidation**: `invalidateUser`, `invalidateAllUsers` and settings writes publish on
  an internal room, so another node drops its copy in about a second (measured 1.0s, against
  a 60s TTL).
- **Mail** (`MailQueue`, `mail_outbox`): any node claims; one UPDATE with a repeated WHERE (no
  `SKIP LOCKED`); a collision comes back empty and is retried next poll; 5 attempts, backoff
  5/10/20/40s, failed rows kept for a day, sent rows deleted. At-least-once. If the database
  will not take the message it is sent inline.
- **Rate limits**: sign-in, TOTP and password change count in `rate_limit_buckets`
  (`config.rateLimit.shared`), with retries on serialization failures, and **fail closed**
  (`skipOnError: false`) if the database cannot count. The general per-IP limit is still per node.
- **Shutdown**: `ClusterJobs` waits up to 6s for jobs that are running, then releases leases, so
  the pool is not closed under a running job.

Found while building it:

- `drizzle()` replaces pg's timestamp parsers for the whole process with ones that return raw
  strings, so a raw `pool.query` in this app does not get `Date`s. The bus store returns epoch
  milliseconds from SQL instead, and the integration test calls `drizzle(pool)` to match
  production. (The first version passed its tests and failed on the live stack because of
  this; it is why that test now exists in that form.)
- A node's first poll must not look back before its own start (found by a unit test).
- Socket.IO still offers `polling` as well as `websocket`; across nodes, polling needs
  sticky sessions. That is phase 4, so until then keep the load balancer sticky or do not
  run more than one node.

Verified: 73 unit tests (36 new across phases 0 and 1: bus, mail worker, leases and jobs), plus 16
real-database tests that pass on CockroachDB 24.2 and YugabyteDB 2024.2 (concurrent lease
acquisition, simultaneous mail claims handing each message to one claimer, 25 simultaneous
rate-limit hits all counted, presence and snapshot round trips); migrations on both engines;
the full smoke suite on the Redis-free stack (171 passed); and a second API node started
against the same database: user events crossed in both directions, a setting written on one
node was visible on the other in 1.0s, a viewer on node 2 received node 1's UniFi snapshots,
presence appeared and cleared, node 2 led no jobs while node 1 was up, and stopping either
node moved all 17 job leases to the other within 12s.

Not done: the per-node search index (phase 2), the `monitor` claim and the database pool
hardening (phase 3), websocket-only transport and identical web builds (phase 4).

## Phase 2 notes

Each node keeps its own Meilisearch, and every index is derived from the database. What was
built differs from the plan in one way: **there is no `search_outbox` table.** Change notices
ride the existing cluster bus (internal room `__search`), which already gives batching,
ordering, de-duplication and no self-echo. The price is that the bus is best effort, so a
full reconcile of the content kinds every 10 minutes (and at start) heals anything it misses.

- **Reconcile by content hash.** Every document carries `rev`, a hash of its content that
  leaves out `updatedAt` (the Cisco and UniFi sources stamp "now" each time, which would make
  everything look changed). A reconcile compares `rev`s and writes or deletes only the
  difference. This replaced the old "delete every monitoring document, then re-add them" every
  2 minutes, which left search briefly empty each time.
- **Content kinds** (ticket, note, wiki): a service calls `search.changed(kind, id)` after its
  database write; the writing node re-reads the resource and updates its index at once
  (read-your-writes), and publishes a notice; the others re-read the resource themselves. A
  change is therefore always applied as the current database content, never as a payload.
  The three ad-hoc doc builders in the services were replaced by one set in
  `search/search-sources.ts` (the incremental ones had no `url`; the reindex ones did).
- **Live kinds** (UniFi, DNS): the node that reads the source calls `syncUnifi` / `syncDns`,
  which diffs against `live_search_docs` (migration 0052) and writes only changed rows, then
  tells the other nodes. Every node indexes from the table, so none needs to reach the
  controller or Technitium, and a new node has them at once.
- **Start**: a new or restarted node reconciles everything before it answers searches (a
  search waits up to 8s, then answers anyway). On the live dev stack the first reconcile removed
  30 stale documents that were not in the database: drift that had accumulated unnoticed.
- **Admin Reindex** rebuilds this node's index and asks every other node to rebuild theirs.
  It now also restores the UniFi and DNS entries from the table (before, they stayed missing
  until the next poll).
- **`SearchService` has no database dependency** any more (document sources and the live
  store are injected), which is what makes it unit-testable with a fake Meilisearch.

Measured on two real nodes, each with its own Meilisearch, on one database: a second node's
empty index was fully built from the database at start (content 15, monitoring 1121, live 126,
matching node 1); a note, a ticket and a wiki page created on one node were found by search
on the other in 0.2-1.1s; edits and deletes crossed the same way; and an admin Reindex started
on node 1 removed a ghost document and restored a missing one on node 2 in about a second,
without losing the UniFi or DNS entries.

Behaviour to know:

- Monitoring kinds are still each node's own 2-minute rebuild, not event-driven, so two nodes
  can differ by a poller's latest changes for up to two minutes. (Seen once: an index with 79
  of 178 infra entities until its next sync, because the infra poller flips `present` while it
  works. The old code had the same exposure.)
- After upgrading from a version without `live_search_docs`, the UniFi and DNS documents are
  absent until their next poll (one poll for UniFi, under a minute for DNS).
- A node's content index can lag the database by up to 10 minutes if the bus missed an event
  (an outage longer than the 60s event retention), until the next content reconcile.

Verified: 89 unit tests (16 new, running two `SearchService`s over a fake Meilisearch,
including diffs, deletes, drift, live kinds, a node without Meilisearch, and reindex); the 21
real-database tests (5 new, for the live store, including a 1,300-document set larger than
one batch) pass on CockroachDB 24.2 and YugabyteDB 2024.2; migration 0052 on both engines; the
full smoke suite on the rebuilt stack (171 passed); and the two-node run above.

## Phase 3 notes

**Monitor worker.** Each node runs a `monitor` worker; `monitors.claimed_until` (migration 0053)
makes them share the work instead of each probing everything. A worker takes due monitors with
one UPDATE whose outer WHERE repeats the inner SELECT's conditions (no `SKIP LOCKED`; a collision
comes back empty and is retried by the pool), probes them, and clears the claim when the check
is recorded. A worker that dies mid-probe delays that check by the claim window (60s,
`MONITOR_CLAIM_SEC`); a clean shutdown hands its in-flight monitors back at once. Due-ness is
judged by the database clock, as UTC wall time to match how `last_checked_at` is stored. The
hourly prune takes a `job:monitor-prune` lease for most of the hour and does not release it, so
one worker prunes per period. Each probe runs from whichever node claimed it, so every node
that runs a worker must reach the monitored targets.

**One pool factory** (`@church/shared/db`, a separate entry point so browser bundles never pull
in `pg`; `packages/shared/db/package.json` is a stub so the API's classic module resolution can
find it). Every process uses `createPool`: the API, its scripts (migrate, seed, resets), the web
app and the monitor worker. It gives each pool:

- an `error` handler (proved below: a plain pool dies on the event a node failure raises);
- `application_name` (`church-api`, `church-web`, ...), connect and idle timeouts, TCP
  keep-alive, and a 30-minute connection lifetime so connections move to live nodes after a
  failover;
- automatic retry (5 attempts, 100ms doubling to 2s, jittered, log lines throttled to one per
  10s) of statements that are safe to repeat. A failure is classified as *pre-send* (never
  reached the database: refused, pool wait timed out), *rolled back* (40001, 40P01) or
  *ambiguous* (connection broke mid-statement). The first two retry anything; ambiguous retries
  only a plain SELECT/SHOW/EXPLAIN (a `WITH` is treated as a write). An ambiguous write is never
  retried. Callback-style queries and submittables are left alone;
- TLS from the URL, plus `HostCheckingClient`: see below.

The lease SQL moved into the same package (`acquireLease`/`releaseLease`) so the API, the migrate
script and the monitor worker share it. The monitor worker now depends on `@church/shared`,
and `scripts/rebuild.sh` now rebuilds `monitor` too (it only knew `api` and `web`, so a monitor
or shared change never reached the running worker).

**Retry scope, decided after the audit.** Only `pool.query` is wrapped. The lease, bus, search and
mail loops already re-run on their next tick and tolerate a failed pass, so they need nothing more.
The only `.transaction()` caller is the DNS sync, which is not safe to repeat as a whole; it is
left alone. `withRetry` is exported for any future whole-function retry.

**TLS (4.3), answered.** pg 8.13 already reads `sslmode`, `sslrootcert`, `sslcert` and `sslkey`
from the URL, so no file-reading code was needed. Tested against a secure single-node CockroachDB:
`verify-full` with the CA works, the migrate script and all 27 real-database tests pass over TLS,
and `sslmode=disable`, a missing CA, a wrong CA path and a wrong password all fail. Two findings:

- pg 8 treats `require` and `verify-ca` as aliases for `verify-full` (and warns), so a self-signed
  cluster CA needs `sslrootcert`; use `verify-full` explicitly.
- **pg does not verify the host name when the host in the URL is an IP address.** Node falls back
  to the name "localhost", and cluster certificates name localhost, so `verify-full` accepted
  a node reached by IP that the certificate does not name. `HostCheckingClient` closes this by
  checking against the real host, and a test shows an IP the certificate does not name is now
  refused. Still: put host names, not IPs, in `DATABASE_URL`.

**Chaos test (4.4).** A throwaway three-node CockroachDB behind HAProxy (health-checked, closing
sessions on a down server), an API node on it, and about 75 requests a second (half reads, half
note creates, every create with a unique title) for 160 seconds:

- **One node killed abruptly under load:** no read failed; one write failed, the one in flight
  at that instant. Nothing else noticed.
- **All three nodes stopped for 31 seconds:** requests failed for as long as the database was
  down (reads after about 1.2s of retrying, writes at once), then **everything succeeded again
  within about 6 seconds of the nodes starting**, with no API restart (0 restarts, still running).
- **Data:** all 3,171 acknowledged writes were in the database (0 lost); the 608 failed writes
  were all absent (0 applied-but-reported-failed); 0 duplicate titles, so no write was repeated.
- **The crash protection matters:** the same fault against a plain `new Pool` ends the process
  (`Unhandled 'error' event`, exit code 1); the shared pool logs it and carries on.

The first attempt at this test looked like a total failure and was not: my load tripped the API's own
per-IP rate limit (1200 a minute), and 7,561 "Rate limit exceeded" responses were most of the
failures. Raised on the chaos instance only (`auth.rate_limit_per_minute`) for the real run.

Verified otherwise: 131 unit tests (42 new) for the retry rules, classifier, pool wrapper and
host checking; the full regression suite (171 smoke + 21 browser tests) on the rebuilt stack; 27 real-database tests (6 new, for the monitor claim: four simultaneous workers
each get a disjoint set, claimed/disabled/not-yet-due monitors are skipped, release and lapse work,
longest-waiting first) on CockroachDB 24.2 and YugabyteDB 2024.2; migration 0053 on both; the
live stack rebuilt (all five monitors checked within two minutes, none left claimed); the web image
builds with the new import.

## Phase 4 notes

**Two builds of the same source were not interchangeable.** Measured: building the web image
twice from identical sources gave different Next.js build ids, different encryption keys and **no
Server Action ID in common**. The sign-in page's Google and Microsoft buttons are Server Actions
(they close over `callbackUrl`), so behind a load balancer a page rendered by one node could be
answered by another that rejected the action. (Password sign-in is a plain form and was never
affected.) The IDs are salted with the build's encryption key, which Next makes random per build.

What was done, which differs from the plan in one way (below):

- **Fixed build-time salt.** The web Dockerfile builds with a constant `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
  (a hash of a fixed string in the Dockerfile). It is only a salt for the action IDs and is not
  secret. The IDs are now identical in every build, on every node, across versions.
- **Run-time key derived from `AUTH_SECRET`.** `apps/web/entrypoint.sh` derives the key that really
  encrypts the values an action closes over from `AUTH_SECRET` (SHA-256 with a fixed label), unless
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set. **The plan said to add a separate shared secret to
  `.env`; this needs nothing new**, because `AUTH_SECRET` already has to be identical on every
  node. The runtime key wins over the one in the build's manifest.
- **A build id, one per release.** `scripts/build-id.sh` gives the commit (or `<commit>-<hash of the
  uncommitted changes>`), compose passes it as `BUILD_ID` to the api, web and monitor images, and
  `next.config.mjs` uses it as the Next build id and `deploymentId`. The api's heartbeat reports it
  as the node's version. `scripts/release.sh` builds the three images once, tagged by build id, and
  prints the `.env` lines (`BUILD_ID`, `API_IMAGE`, `WEB_IMAGE`, `MONITOR_IMAGE`) for the nodes.
  Compose accepts those image names; the defaults are unchanged (`church-api`, ... and
  `church-prod-api`, ... for prod).
- **WebSocket only** on the gateway and all three clients, so no sticky sessions.
- **`TRUSTED_PROXIES`** (see below), **`/healthz`** and **drain**.
- **`readyz` returns 503** when the database cannot be reached (it returned 200 with
  `status: degraded`), because the load balancer's check goes through it.

**Verified (and what the checks found).**

- *Independent builds.* Two from-scratch (`--no-cache`) web builds with **different** build ids share
  the same salt and the same Server Action IDs (before: none), but 4 of 279 static files differ
  (the per-build manifests and two chunks that embed the id), so nodes must share a build id. Two
  from-scratch builds with the **same** build id have identical static file lists and an identical
  Server Action manifest. So "build the same clean commit on each node" works.
- *A real browser behind a round-robin load balancer* over two independently built nodes: 10 of 10
  Google sign-in clicks succeeded with the page from one node and the action on the other, in both
  directions, zero failed static assets. A control node with a different run-time key failed 8 of
  8 with a 500, so the test does detect the problem. (An earlier run across *different* build ids
  passed only by luck of how requests alternated, and failed three static assets in one round: that
  is the 4-file difference above.)
- *Password sign-in across nodes* (live dev API, two web nodes behind a round-robin balancer): 6 of
  6, every round spanning both nodes (the form from one, the CSRF token, credentials post and
  landing page from the other). So Auth.js needs nothing extra per node: JWT sessions and the CSRF
  token are stateless given the shared `AUTH_SECRET`. The only per-node state in the web app is its
  30-second cache of the sign-in provider settings, so a provider toggle can take that long to
  reach every node.
- *`TRUSTED_PROXIES`, measured with a forged `X-Forwarded-For: 9.9.9.9, 8.8.8.8`:* the **old**
  configuration reported 9.9.9.9 (the forged value won, since it trusted every peer and took the
  leftmost entry). With `TRUSTED_PROXIES` set to the balancer's range the API sees 8.8.8.8; a
  chain through another trusted hop gives the real client; a sender outside the list is ignored. The
  default (unset) is **unchanged on purpose**: `trusted_proxies_strict` with everything trusted
  would report the proxy's own address for every user, so compose turns strict mode on only when
  `TRUSTED_PROXIES` is set.
- *`/healthz`:* 200 with the node name header while the API reaches its database, 503 when the API
  readiness fails, 503 `draining` while `data/caddy/drain` exists (the site itself keeps serving
  while drained), 200 again after `scripts/cluster.sh undrain`.
- *Transport:* through the real proxy a WebSocket client connects and a polling-only client is
  refused. A tab opened before this change still lists polling first and is refused until it reloads.

Also fixed: `scripts/rebuild.sh` ignored `.yml` and `Caddyfile` changes and never restarted the proxy,
so a proxy config change did not take effect until a manual restart; it now detects them and
recreates and restarts the proxy.

**What `deploymentId` does.** In Next 15.1.6 the browser sends the id as an `x-deployment-id` header on its
navigation requests and adds `?dpl=<id>` to script and style URLs. Self-hosted Next does nothing else
with it: **there is no automatic reload on a mismatch** (that is a platform feature). It is a hook a load
balancer can route on, to keep a browser on the build that served its page during a rolling upgrade; that
routing is not set up or tested here.

**The rolling-upgrade window is real.** Because 4 of 279 static files are named by the build, while nodes
run different builds a page from one can reference a script the other node lacks (a 404 until the user
reloads). Keep the window short, drain a node before upgrading it, and expect an occasional reload; or have
the load balancer route on `dpl` / `x-deployment-id`. Server Actions are not affected (their IDs are the
same in every build).

`scripts/cluster.sh` grows `init-certs`, `init`, `join` and `remove-node` in phase 7.

## Phase 5 notes

**What was built.**

- **`S3_*` settings** (`attachments/s3.config.ts`, a pure function with 22 unit tests): `S3_ENDPOINT` (host[:port] or a
  URL, no path), `S3_USE_SSL`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_SESSION_TOKEN`,
  `S3_PATH_STYLE`. Each falls back to the old `MINIO_*` name, so an existing `.env` needs no change. A TLS flag that
  contradicts the URL scheme is refused at start. `attachments/minio.client.ts` became `s3.client.ts` (`getS3()`).
- **`S3_MODE=bundled|external`**, chosen like `DB_MODE`: `scripts/compose.sh` validates it (bundled with an endpoint
  elsewhere, external with the bundled one, or external without keys all stop with a message), puts the bundled
  `minio` and `minio-init` behind a `bundled-s3` profile, and the api's `depends_on` for them is now optional.
  External mode starts no MinIO. `minio-init` honours `S3_BUCKET` as well as `MINIO_BUCKET`.
- **Health**: the storage probe reports **degraded** (with what to do) when the bucket does not exist, shows the
  endpoint, bucket, region and addressing but never the keys, and reports kind `s3` for anything that is not the
  bundled store.
- **`scripts/s3-copy.sh`** (6.3), a thin wrapper over `scripts/s3-copy.cjs`, which runs inside the api image: copies
  every object between two stores and proves the copy by SHA-256 of every copied object at both ends. Nothing is deleted.
- **`scripts/db-s3.sh`** and `make db-backup-s3 | db-list-s3 | db-restore-s3` (6.4): `BACKUP DATABASE church INTO
  s3://<bucket>/db-backups/...` and a safe restore (into a copy, swapped in only on success; straight into place on a
  cluster that has no `church` yet). `DB_S3_CONTAINER` points the SQL at a throwaway Cockroach so a restore can be tried
  without touching the real one.

**Verified.**

- *External store, `S3_*` only:* an API given no `MINIO_*` variables at all, a store whose secret key is `ext/secret+key=1`
  (the characters generated keys contain), a real upload, download (byte-identical), and delete through the API; the
  object appears in the store while attached (one 70-byte object) and is gone after the delete; storage health goes from
  *degraded* (bucket missing) to *ok* on the first upload.
- *Copy:* the real dev bucket (38 objects, 5 MiB) to a second store: identical SHA-256 after copying; a second run copies
  nothing; deleting an object at the destination makes the next run restore it; and replacing an object with **different
  bytes of the same size** is found and repaired. A wrong secret fails with a clear message and exit 1. A dry run into a
  bucket that does not exist says so.
- *Backup/restore:* the real dev database (1.84 million rows, 1.3 GB) backed up to a second store and restored into a
  **separate, empty cluster** in 18 seconds, row counts equal (the metrics table differs by the rows the live stack added
  after the backup). A **failed** restore (a bucket with no backups) left the existing `church` untouched with no leftover
  copy; a **successful swap** replaced it (a row added after the backup disappeared). Cockroach does not create the bucket:
  a missing one fails with a clear error and a non-zero exit. The secret key is masked in all output.
- Typecheck, 156 unit tests (22 new), the 27 real-database tests, and the full regression (171 smoke + 21 browser tests,
  which upload and download attachments through the bundled MinIO using the new code path).

**Findings.**

- **The bundled MinIO cannot be installed on a new host.** `minio/minio` and `minio/mc` are no longer pullable from
  Docker Hub ("repository does not exist or may require login") and quay.io refuses them (`unauthorized`), including old
  pinned tags; Garage (`dxflrs/garage`) and SeaweedFS are available (a control pull of `alpine:3.20` worked, so the
  check is valid). The running stack uses a copy pulled earlier (`RELEASE.2025-09-07`). A fresh `make up` therefore fails
  at the bundled MinIO. It was settled afterwards by moving the bundled
  store to Garage (Phase 6 notes); this resolves the plan's open item about MinIO's status: the risk was real.
- **`mc` does not decode a percent-encoded secret** in `MC_HOST_<alias>` URLs, so any `mc` use built that way fails on a
  key containing `/`, `+` or `=`. My first `s3-copy.sh` did exactly that; the copy now uses the app's own client.
- **`mc mirror` / `mc diff` compare name and size only.** A same-size object with different content passed as
  "identical", and mirrored objects get a multipart-style ETag even at 70 bytes, so comparing ETags between stores does
  not work either. Verification is by SHA-256, which is why the copier is Node code in the api image (the `mc` image has no
  hashing tools at all).
- A scratch database `church_it` from my phase 3 tests had been left in the dev Cockroach (82 tables); dropped.

**Not done / still open.**

- **(Closed in phase 8.) Milestone M1 (shape D) was code-complete but not declared supported.** Phases 0-5 now give a node everything it needs
  to run against a remote database and an external store (`DB_MODE=external`, `S3_MODE=external`, per-node search, shared
  jobs, realtime and cache invalidation through the database, one build, a drainable `/healthz`). What is missing is the
  end-to-end proof: two full stacks behind a load balancer on one database and one store, running the smoke suite and
  read-after-write checks across them (item 8.2).
- `S3_PATH_STYLE=false` (virtual-hosted, what AWS prefers) and a real AWS S3 / Backblaze endpoint are untested: only MinIO
  was available to test against.
- `make db-backup-s3` covers the bundled database; the cluster form (any node, three-node secure cluster) arrives with
  phase 7.

## Phase 6 notes (Garage, brought forward)

Phase 5 found that the bundled MinIO cannot be installed on a new host (its images are withdrawn
from Docker Hub and quay.io). The decision was to use **Garage for the single node too**, which
turned the clustered-Garage work into the default path. What is done is the **single-node** form
(replication factor 1); the multi-node form (layout across nodes, replication, joining and
removing a node) belongs with phase 7.

**Built** (`infra/garage/`):

- An image that adds an Alpine shell to the static Garage binary (the official image has no
  shell, so no init script could run in it). Config, entrypoint and init script are bind-mounted,
  not baked in.
- `garage` and `garage-init` services (compose profile `bundled-s3`, dev and prod) replace
  `minio` and `minio-init`. The init is idempotent: it gives the node a layout role, imports the
  access key, creates the bucket and allows the key.
- **Credentials derived from `AUTH_SECRET`** in `scripts/compose.sh` (key id `GK` + 24 hex, 64-hex
  secret, and the RPC secret). Garage rejects any other key format (tested), so MinIO-style keys
  cannot be used; deriving them means nothing to configure and all nodes of a cluster agree.
  `compose.sh --s3-env` reports what the app uses, and `s3-copy.sh` and `db-s3.sh` read it from there.
- **A guard against LMDB on NFS.** This repo's `./data` is on NFS on the dev host, and Garage keeps
  its metadata in LMDB. The entrypoint refuses to start when the metadata directory is on a network
  filesystem (tested: refused on the NFS share, accepted on local disk, overridable);
  `GARAGE_META_DIR` moves it, and `.env` here sets it to `/home/josh/church-garage-meta`.
- `s3-copy.sh --from-minio --to-bundled` for moving an install over, `--from-region`/`--to-region`,
  and a warning from `compose.sh up` if `data/minio` has files and the Garage data is empty.
  Health now reports kind `garage`.

**Verified.**

- *Garage as the app's store:* every operation the attachment code uses works (stat, put with
  Content-Type, get, list, delete, a 12 MiB multipart upload); bucket creation is denied to the key,
  as intended (the init creates the bucket).
- *Migration of your real dev install:* 38 objects (5 MiB) copied from the running MinIO into Garage,
  SHA-256 verified; a second run found nothing to do; the app was then restarted onto Garage and the
  four wiki attachments with valid parents served byte-for-byte (the two ticket attachments are
  orphans whose tickets no longer exist, so they 404 correctly).
- *Backups to Garage:* a 1.85-million-row, 1.3 GB Cockroach backup in 14 s (266 MB, 122 objects) and a
  restore into a separate empty cluster in 18 s with matching counts, over multipart uploads.
- *Idempotent init, key rotation, persistence* (on a scratch Garage): a second init does nothing; after a
  derived-key change the new key works and the old one stays valid; the layout, key and objects
  survive a Garage restart; and a restart of the dev Garage under the running app was fine.
- Full regression on the Garage-backed stack: 171 smoke and 21 browser tests, which upload, download and
  delete attachments for notes, tickets and wiki.

**Findings.**

- A scratch test I wrote resolved the name `garage` to the real dev Garage on the shared network instead
  of the scratch one (container *names* resolve; `--hostname` does not). Nothing was changed on the dev
  Garage (checked: one key, one bucket, one node), but it is why scratch containers here are named
  differently from compose services.
- The Garage CLI needs `-c /etc/garage.toml` in our image, and its binary is `garage` on the PATH
  (`/garage` only in the official image).
- Compose interpolates services of inactive profiles too, so `${GARAGE_RPC_SECRET:?}` broke
  `S3_MODE=external` until `compose.sh` exported a placeholder for it.
- An INSTALL.md edit of mine briefly duplicated 64 lines (a Python slice matched a table header that
  occurs twice); found by checking the section list, removed, and the diff against HEAD re-read.

**Multi-node Garage** (one layout across nodes, replication factor 2 or 3, the RPC port on
`CLUSTER_BIND_ADDR`, adding, replacing and removing nodes) was done in phase 7: see
[Phase 7 notes](#phase-7-notes). The CLI is then `garage -c /tmp/garage.toml` (the config is rendered
from a template). The MinIO containers on the dev host were stopped, not removed, and `data/minio` is
untouched, until you are sure.

## Phase 7 notes (bundled cluster, shape C)

**Built.**

- `scripts/compose.sh` understands `DEPLOY_MODE=single|cluster` (cluster = production stack only),
  `NODE_ID`, `NODE_ROLE`, `NODE_ADDR`, `CLUSTER_PEERS`, `CLUSTER_BIND_ADDR`, `CLUSTER_DB_PORT`,
  `CLUSTER_S3_RPC_PORT`, `CLUSTER_S3_CAPACITY`, `CLUSTER_S3_API_PORT` and `GARAGE_REPLICATION_FACTOR`;
  rejects impossible combinations (no NODE_ID, a witness with an external database or store, a
  replication factor larger than the node count, dev compose in cluster mode, missing certificates on
  `up`); builds the compose file list (`docker-compose.prod.yml` + `cluster.yml` + `cluster-db.yml`
  + `cluster-s3-api.yml`); derives the database password; and prints everything resolved with
  `--cluster-env` / `--deploy-mode`. `check-ports.sh` checks the cluster ports in cluster mode.
- `infra/docker-compose.cluster-db.yml`: one **secure** `cockroach` per node (own profile
  `cluster-db`; certificates mounted read-only; port published on `CLUSTER_BIND_ADDR`; admin UI on
  the container's loopback only; healthcheck unhealthy until the cluster is initialised). The app
  signs in as user `church` over `sslmode=verify-full` and each node's app uses its own node's
  database. `cluster.yml` publishes Garage's RPC port; `cluster-s3-api.yml` is the opt-in S3 port.
- Garage's config became a template (`garage.toml.tpl`, rendered by `garage-render.sh`) so the
  replication factor and the public RPC address come from the cluster settings; `garage-init` in
  cluster mode no longer touches the layout (only key and bucket) and now says why when a step fails.
- `scripts/cluster.sh`: `init-certs`, `install-certs`, `start-data`, `init-db`, `node-id`,
  `garage-bootstrap`, `garage-join [--replace]`, `garage-remove-node`, `db-remove-node`, `migrate`,
  `seed`, `sql`, `up`, `status` (database members and object store nodes as this node sees them),
  plus the earlier `drain`/`undrain`. `scripts/db-s3.sh` works in a cluster (certificates; refuses a
  restore while another node's app is up; hands restored tables to the app user).
- `tests/cluster/`: `sim.sh` (N nodes on one host, each a copy of the repository with its own `.env`,
  data and compose project, so the real scripts run), `cross-node.mjs`, `failover.sh`,
  `replace-node.sh`, `witness.sh`.

**Verified** (three simulated nodes on this host, secure Cockroach and a three-node Garage, the
procedure in INSTALL.md followed from empty):

- The full smoke suite (171) passes through a node of the cluster; `cross-node.mjs` passes: a session
  from one node is accepted by the others, a note written on one is read on the others, a 6 MB upload
  written through one downloads byte-identical through all, and each node's own search index finds a
  note made elsewhere.
- *A: a node stops.* Its leases are released, nodes 2 and 3 hold all 17 jobs, serve reads, writes and
  uploads (including an upload stored before), and the node rejoins both clusters when started.
  *A2: a node is killed* with no clean shutdown: its leases expired 8 to 10 seconds after the kill (the
  TTL is 30 s, renewed every 10), the survivors took all 17 jobs and kept serving.
  *B: two of three nodes stop* (no database majority): the remaining node's readiness answers 503
  within 2 to 3 seconds, and everything recovers when they return, with the stored upload intact.
- *Replacing a node that lost its disks* (data directories moved aside, so it restarts empty), three
  times (node 3 twice, node 2 once): database member removed (a wait of about five minutes for the
  cluster to declare it dead), object store joined in its place in one layout change, upload intact.
- *Adding a fourth node* and *removing a live node* (database decommission and layout removal) both work
  and leave Garage with a single live layout version.
- *Certificate renewal*: new node certificates issued from the existing CA, installed, and reloaded with
  SIGHUP on all nodes with no restart (new serial presented, cluster unchanged).
- *Backup and restore in the cluster*: backup to Garage, restore refused while three other nodes run,
  restore after stopping them, and the application starts (the restored tables are handed to the app user).
- The 27 database integration tests pass against the secure cluster, as the non-root `church` user, over
  `sslmode=verify-full`. A rolling upgrade (drain, `up` with the new build, undrain, per node) left
  the database and object store containers alone and worked.
- *Witness* (`NODE_ROLE=data`, two application nodes + a witness): either application node can be stopped entirely and the other, with the
  witness making up the majority, serves the stored upload and accepts writes and uploads; both serve
  again after the stopped one returns (`tests/cluster/witness.sh`). The witness runs only `cockroach` and
  `garage`.
- *`compose.sh`'s rules* are covered by `tests/cluster/compose-config.sh` (29 checks: 14 rejections, the
  resolved join list, replication factor and per-peer ports, and the compose files it produces); it needs
  no containers.

**Bugs found by this and fixed.**

- `/readyz` ran `SELECT 1`, which CockroachDB answers without touching a range: a node that lost its
  quorum kept saying "ready" while every real query hung. It now reads a table under a server-side
  statement timeout.
- Even the liveness endpoint stalled during that outage: the rate limiter reads a setting on every
  request, and an expired cache entry waited for the dead database. `SettingsService.get` now serves the
  stale value when a refresh is slow (one refresh in flight per key; unit-tested).
- `garage-join` assumed the layout had already reached the new node (an empty layout also prints
  "version 0"); and joining then removing the dead node as two layout changes left versions the dead
  node could never acknowledge ("Could not reach quorum"). Replacing is now one change (`--replace`),
  followed by `skip-dead-nodes`. `garage-init` hid its errors; it now prints a failed command's output
  with secrets masked.
- A restore left the tables owned by root, so the app's `church` user had no privileges and the API would
  not start; the restore now hands the database over (and `init-db` can do it again by hand).
- On a first install the API cannot start against an empty database (it reads settings at boot), so
  `exec api ... migrate` is not available; `cluster.sh migrate|seed` use a one-off container. This is
  an old property of fresh installs, only more visible here.
- Near-miss: I ran `make prod-up` in the repo root to see a new guard message. It was single mode, so it
  began building the production stack, which shares `./data` with the live dev stack; it was killed
  during the image build, before any container existed, and nothing was touched. CLAUDE.md and memory now
  say never to do that here, and to use the simulator.

**Not verified, and limits.**

- Everything ran on **one host**: nodes reach each other through published ports on the host's own
  address, so there is no real network between them (no latency, partitions or asymmetric failures
  were tried), and disk loss was simulated by moving directories aside.
- The conversion of a real single node install (INSTALL.md) was not run end to end; its pieces were
  (backup, the copy between stores read through the published S3 port in a dry run, restore with
  hand-over). Rotation of the CA itself is described, not tested. Shape D (remote database) is still
  unproven (the two-stack harness is phase 8), and the database pool's failure behaviour was chaos-tested
  on Cockroach only.
- Decommissioning a dead database member waits for the cluster to declare it dead (5 minutes by
  default). Garage's healthcheck (`nc` against its ports) makes its log print a handshake error every
  3 seconds: cosmetic. `cluster.sh up` always passes `--build` (a no-op when the image is current).
- The simulation shares one certificate bundle between its nodes (one address), so it does not
  exercise a per-node certificate; the SAN list is checked only by the `verify-full` connections.

## Phase 8 notes (visibility, shape D proof, docs)

**Built.**

- **Admin Cluster page** (`/admin/cluster`, `apps/api/src/cluster-admin/`, `site:admin`): every app node (live or
  stopped, address, build, started, last check-in, how many jobs it leads, a Forget button for a dead one), which
  node leads each background job and how often it changed hands, the database (engine, answer time), the object
  store (reachability, and for the bundled Garage each node's up/down, zone, offered capacity and free disk from
  Garage's admin API, which `compose.sh` now hands the API), one-off leases (a backup or restore in progress) and a
  list of problems from the pure `findProblems` (stale node, differing builds, a job nobody leads, slow or
  unreachable database or store, a Garage node down or draining). Refreshes every 5 s.
- **Node watch**: the `cluster-watch` job notifies the administrators when a node stops checking in for a minute
  and again when it returns (`cluster.node_down` notification kind, baseline in `job_state` so a new leader does
  not repeat it, silenced by maintenance mode).
- **Read your own writes across nodes** (`cluster/read-your-writes.ts`, `ClusterBus.flushNow` / `syncSince`): see
  Findings. Only active when `DEPLOY_MODE=cluster`.
- **Shape D harness** (`tests/cluster/shape-d.sh up cockroach|yugabyte | test | down`, extending `sim.sh`): a throwaway
  CockroachDB or YugabyteDB container and a standalone Garage as "your own" services, two app nodes configured exactly
  as INSTALL.md says (DEPLOY_MODE=cluster, DB_MODE=external, S3_MODE=external, nothing else cluster-specific), and a stock
  Caddy round-robin balancer using the documented `/healthz` contract. `node-watch.mjs` drives the alert check.

**Verified**, on both engines (all nine checks of `shape-d.sh test` pass on each):

- the whole smoke suite (186) through the balancer, requests alternating between the nodes; both nodes answer
  (6 and 6 of 12 health checks); `cross-node.mjs` (sessions across nodes, read-after-write, a 6 MB upload read from both,
  each node's own search); backup on one node, compare and restore on the other with writes probed through it, undo,
  upload (12 checks); node 1 stopped (10 of 10 health checks answered by node 2, the smoke suite passes again, node 1
  rejoins); the Cluster page data (both nodes live, 20 of 20 jobs led, database and store ok, no problems); a node killed
  for real (the admins were told 58 s after the kill, once, and again 15 s after the restart, and the problem
  cleared from the page); and the full Playwright suite (28) through the balancer, pages, Server Actions, static files
  and WebSockets served by whichever node the balancer picked.
- the dev single-node stack: `make regression` (186 smoke, 28 browser), 212 unit tests; shape C was re-run after the
  bus change (cross-node, backup-restore, failover, node death).

**Findings.**

- **A change was not visible on the other node.** The first run through the balancer failed 11 of 186 smoke tests:
  after a password change on one node the next write, served by the other, was refused with 403 (its cached user still
  had `mustChangePassword`), and the same stale window showed in TOTP enrolment, settings and a notes update. The
  bus invalidates other nodes' caches, but only on their next poll (up to a second), and a balancer without stickiness
  sends the very next request anywhere. Fixed with a consistency token: a mutating response first flushes its
  invalidation events and sets a 10 s cookie holding the time; a request with that cookie makes its node poll once if
  its last poll began before then (shared by concurrent requests, capped at 1.5 s). The web tier's proxy relays the cookie.
  After it: 185 of 186, the last being a bearer-token call (no cookie jar, so it sees the change within about a
  second); that check now allows for it. Unit tests cover the cookie, the shared poll, the cap and the hooks.
- Harness bugs found on the way (all in the tests, not the app): `reset_user` used the node being stopped, `tee
  /dev/stderr` truncated its own log, the clipboard API needs a secure context so the browser suite must address the
  balancer as `localhost`, a smoke assertion assumed a non-empty `settings` table, `cluster.sh migrate` ran a stale
  image (fixed in phase 7), and a single-node Cockroach container refuses a `--listen-addr` that is not local. One app fix from the shape C re-run: `garage-init` failed with "Could not reach quorum" when a node's Garage was recreated while its peers were still reconnecting; it now retries for about a minute.

**Not done, and limits.**

- **No Monitoring tile and no database node count.** The plan asked for both. A tile would repeat the page's data in
  a second place; a database member count needs a Cockroach-only catalog read, which the portability rules forbid, so
  the page shows the engine and the answer time (the bundled cluster's members are in `cluster.sh status`).
- **Server actions** that call the API with `apiFetch` do not relay the consistency cookie to the browser (the route
  handlers do). No current server action both changes cached state and is followed by a read on another node within a
  second, but a new one could; CLAUDE.md says so.
- Still one host: no latency, partitions or asymmetric failures. Real AWS S3 and virtual-hosted addressing are untried.

## Risks and open items

- **Two nodes is not HA** for the bundled database. This is a property of quorum, not of
  the code. The guide says so and offers the `data` witness (tested in phase 7: two application nodes
  plus a witness survive losing either application node).
- **Shape A in prod today runs three Cockroach containers on one host.** The target table
  says "single-node CockroachDB". Undecided: keep the three containers for shape A in
  prod (process-level resilience, more RAM) or drop to one. INSTALL.md describes what the
  prod compose does today.
- **The MinIO images are gone from Docker Hub and quay.io** (checked 2026-10-04). Resolved by moving the
  bundled store to Garage for every shape (Phase 6 notes). Pin Garage (`dxflrs/garage:v2.1.0`, in
  `infra/garage/Dockerfile`) and check it is still pullable before relying on a fresh host.
- **`ON CONFLICT ... DO UPDATE ... WHERE`** (the lease statement) is verified on Cockroach
  24.2 and YugabyteDB 2024.2. YugabyteDB 2026.1 is still to check. The single-statement
  claim pattern for the mail outbox and monitor claims (phases 1 and 3) passes its integration
  tests on both engines (24.2 and 2024.2), and the phase 7 cluster tests ran on Cockroach only.
- **Realtime latency** is up to about 1s for events produced on another node (measured
  0.85s). Nothing in the app is known to depend on sub-second cross-node delivery.
- **Events table write load.** Cheap at church scale, but it is the reason large payloads
  go through `live_snapshots` (2.2) and why presence uses heartbeats, not per-event writes.
- **Pollers and network position.** The node that wins a lease does the polling, so every
  node that can win must reach UniFi, switches, printers, UPS, DNS and monitored hosts.
  Use `BACKGROUND_JOBS=off` for a node that cannot.
- **Nodes at different sites.** The database cluster adds write latency across a WAN.
  Recommend one LAN or a low-latency link; do not promise geo-distribution.
- **Clock skew.** A Cockroach node whose clock drifts past the maximum offset (500 ms by
  default) shuts itself down. Require NTP on every node. Leases use the database clock so they do not depend on it.
  The read-your-writes cookie compares wall clocks between nodes (with a 250 ms allowance), so it relies on NTP too.
- **Rolling upgrade skew.** Between the first and last node upgrading, a user can be served
  HTML from one build and static assets from another (4 of 279 files differ per build id, measured).
  Draining a node before upgrading it (`scripts/cluster.sh drain`) shortens the window; routing
  on `dpl` at the load balancer would close it. Neither makes it zero: see the Phase 4 notes.
- **Cockroach licensing.** The pinned v24.2 is what we run today. Later Cockroach releases
  changed their licence terms; check them before bumping the pin for a cluster.
- **Garage differences.** Garage covers the five S3 calls the app uses, but not every S3
  feature (no versioning, ACLs or server-side encryption). Nothing in the app needs them
  today; keep it that way or re-check before adding any.
