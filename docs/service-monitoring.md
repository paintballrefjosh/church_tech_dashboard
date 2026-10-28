# Service monitoring (templates)

Status: **built 2026-10-26** (phases 0-4 and the MCP read tools of phase 5). Section 0 says what was built and which of the
proposed decisions were taken; sections 1-11 are the original design, kept for the reasoning. Where they differ, section 0
is what the code does.

In-depth monitoring of the *services running on* an infrastructure host (HAProxy, databases, DHCP, DNS ...), beyond what
[infrastructure-monitoring.md](infrastructure-monitoring.md) already does (CPU, memory, disk, network, Docker containers,
Proxmox guests). Examples: for HAProxy, frontends/backends down, session counts, response time, 5xx rate; for a database,
cluster health, replication lag, connections, read/write latency, errors.

## 0. As built

**Where it lives.** Rules and the format: `packages/shared/src/service-monitoring/` (`template.ts` the Zod format and
`serviceTemplateProblems`, `expr.ts` the expression language, `parse.ts` the parsers, `engine.ts` turns collector rows into
values, states, members and checks, `render.ts` fills placeholders, `builtins.ts` the built-in templates and
`suggestTemplates`, `api.ts` the route shapes). The API: `apps/api/src/service-monitoring/` (`transports.ts`,
`service-monitoring.service.ts`, `service-poller.ts`, the controller under `/api/v1/service-monitoring`). Migration 0085. The
web: a **Services** section on each infra host's page, a page per service (`/monitoring/infra/<host>/services/<id>`) and
**Service templates** (`/monitoring/infra/service-templates`, linked from the Infrastructure tab) with the Logins tab.

**Built-in templates** (code, never in the database, cannot be changed or deleted; fork one to change it): HAProxy,
keepalived, PostgreSQL, MariaDB/MySQL, CockroachDB, YugabyteDB, Apache, Kea DHCP, Technitium DNS; wave two (2026-10-26,
`BUILTIN_TEMPLATE_VERSION` 2): Redis/Valkey, nginx, RabbitMQ, chrony, Postfix mail queue, mdadm (software RAID), ZFS pools,
systemd failed units, Garage, Meilisearch; and the generic ones:
Prometheus metric, JSON endpoint (one number), systemd unit + port + log pattern, SQL query returns a number. Custom
templates are rows in `service_templates` (versioned; `forked_from`). The Kea and Technitium fixtures were written from the
vendors' documentation, not captured from real servers: check them against a real one when one is added.

**Decisions taken** (section 9):

| # | Decision |
|---|---|
| 1 | Agentless. |
| 2 | Named **logins** (`service_logins`: user name + encrypted password, shared by many services); an input of type `login` holds `{loginId}`, and a per-instance secret input is the override. |
| 3 | Yes: a breaching check opens a `monitor_incident` on the HOST (`target_id` = host, `rule_id` = `svc:<instance>:<check>`), so acknowledging, escalation, alert channels, maintenance mode and the host's alert history all apply; notices reuse `infra.alert.opened` / `infra.alert.resolved` (urgent, outage kinds). |
| 4 | Deferred (per host only). |
| 5 | Neither JSONata nor CEL: a small **closed grammar of our own** (`expr.ts`: literals, `inputs.x`, row fields, comparisons, `and/or/not`, arithmetic, a fixed list of functions). No loops, no user functions, no property access beyond a row's own fields, a length and depth limit. Both candidates were larger than the templates needed and neither is in the dependency tree. |
| 6 | A sibling table: `service_metric_samples` (one wide jsonb row per poll, raw kept 7 days) and `service_metric_rollups` (long format: instance, bucket `5m`/`1h`, ts, metric; min/avg/max; kept 90 / 365 days), built with `jsonb_each` and `e.value::text::float8` so the SQL is the same on CockroachDB and YugabyteDB. |

**Rules the code keeps** (also in CLAUDE.md):

- **Commands are confirmed by the person, every time they are about to run on a new footing.** A template with an `ssh`
  collector needs `confirmCommands` equal to `templateCommands(body)` (the exact lines, `sudo -n` included) to SAVE it, to
  ADD it to a host, to TEST it, to change an instance's inputs and to switch an instance back on; otherwise 409
  `{code: "confirm_commands", commands}`, which the web shows as the list and a tick box. Forking a template that runs
  commands needs the same. This is a "you read what will run" step, not a permission: the permission is
  `monitors:write:any` (the Monitoring admin tier), which is what can already run updates on a host.
- **`ssh` collectors need the host's key already pinned** (the infra host's normal login) and run with that host's own
  login; `sudo: true` becomes `sudo -n sh -c <quoted>` (never a password).
- **SQL is read-only three ways**: `sqlReadProblem` allows only SELECT/WITH/SHOW/EXPLAIN/VALUES/TABLE/DESCRIBE and refuses
  `INTO OUTFILE`/`DUMPFILE`; PostgreSQL runs in `BEGIN READ ONLY` with a `SET LOCAL statement_timeout` and the extended
  protocol (`queryMode: "extended"`, one statement only: with the simple protocol `SELECT 1; COMMIT; CREATE TABLE ...`
  ran as the login, found in testing against a real server); MySQL/MariaDB runs `SET SESSION TRANSACTION READ ONLY` then
  `START TRANSACTION READ ONLY`, `multipleStatements` off (DDL commits implicitly in MariaDB and escaped a read-only
  transaction alone, also found in testing). Use a login that can only read anyway (the templates' `needs` text says which).
- **Addresses**: loopback, link-local and one-word names (the stack's own containers) are refused, also after DNS, for
  every transport; HTTP redirects are not followed; a response is cut at 5 MB.
- **Secrets** (secret inputs, login passwords) are encrypted, returned as `[saved]` (which keeps them; `""` removes them),
  scrubbed from errors and raw output, never available to expressions (`serviceExprInputs` leaves secret and login inputs
  out, so no metric, state or check text can print one), redacted from the audit log.
- **Polling** is the `service-poll` cluster job (10 s ticks, at most 4 services at once, each CLAIMED with `claimed_until`,
  180 s); a service on a switched-off host, or switched off itself, is not read. Counters (`kind: counter`) become rates
  between two polls, kept on the instance row. Members (backends, pool members, peers) are kept on the instance row too, at
  most a few hundred, not in `infra_entities` (the infra collector marks those absent on every poll).
- **Retention**: `service-prune` (hourly). **Rollups**: `service-rollup` (5 min).
- Backup registry: templates, logins and instances are `data` (`password_enc`/`secrets_enc` sensitive, the poller's columns
  volatile); samples and rollups are `skip`.
- MCP: read tools only (`services_list`, `services_get`, `services_get_series`, `services_list_incidents`,
  `service_templates_list`, `service_templates_get`); writes, logins, Test and suggestions are excluded (curation, and they
  reach live hosts). Test, Check now and suggestions are `@OperationalOnly` for API tokens.
- Search kind `service_instance` (Monitoring read).

**Tests**: `apps/api/test/service-monitoring.test.ts` (expressions, parsers, placeholders, template checks, every built-in
against a fixture in `test/fixtures/service-monitoring/`), `service-monitoring.integration.test.ts` (CockroachDB and
YugabyteDB: claims, incidents, rollups, prune, secrets, confirmations, a read-only SQL query through a saved login, refused
addresses), `service-sql-transport.test.ts` (opt-in, `TEST_SVC_POSTGRES` / `TEST_SVC_MYSQL=host:port:user:password`:
the PostgreSQL and MariaDB templates against real throwaway servers, as the monitoring login AND as a superuser, proving
nothing is written), smoke `tests/smoke/service-monitoring.mjs` (reaches no real service), e2e `service-monitoring.spec.ts`.
Not verified: the HAProxy, keepalived, Apache, Kea, Technitium, CockroachDB and YugabyteDB templates against the church's
real servers (fixtures only).

**YugabyteDB tablet server (2026-10-28).** The template read the tablet server's whole `/prometheus-metrics`, which lists every
table and tablet: 1.2 MB on an empty single node, and past the transport's 5 MB cap on the church's cluster, so its `tserver`
reading failed ("the answer is larger than 5 MB") and RPC connections, clock skew and follower lag stayed empty. It now asks for
its four names only (`?metrics=...&show_help=false`, under 1 KB on that node; the server matches names loosely, so `keep` still
picks them exactly; `BUILTIN_TEMPLATE_VERSION` 3). The cap stays: a page that big is the wrong page, not a limit to raise. Run for
real against a throwaway 2024.2 node (`TEST_SVC_YUGABYTE=host` opts in). The service page also showed one failed optional
reading twice, as a red last error and an amber "readings that failed" line: red is now only for a service that could not be
read at all.

**Wave two notes.** Redis/Valkey reads `INFO` over the `tcp` transport, which gained two fields for it: `parse` (rows out of
the answer, otherwise the old single row) and `redisAuth` (a `secret_ok` slot: the password is sent first as `AUTH` in RESP
framing, every argument length-prefixed, so it is data and never syntax; `respCommand` in `transports.ts`). The template's
own `\r\n` escapes are now turned into CR/LF BEFORE values are filled in (they used to be unescaped after, so a value typed
as the four characters `\r\n` became a line break; render already refuses real line breaks in values). Pgbouncer was left
out (its console refuses `BEGIN READ ONLY`, which the sql transport always sends), and so were Windows, Samba, SMART (root
only) and Proxmox Backup Server (no server to capture from). The mdadm and ZFS fixtures were written from the kernel's and
the zpool manual's formats; everything else was captured (fixtures README), and the Redis template was run for real against
a throwaway Valkey master and replica (`TEST_SVC_REDIS=host:port:password` opts in).

**Service groups** (migration 0087, `service-groups.service.ts`, rules `packages/shared/src/service-monitoring/groups.ts`,
pages `/monitoring/infra/service-groups` and `/monitoring/infra/service-groups/<id>`, linked from the Infrastructure tab):
services on DIFFERENT hosts that make one thing (a database cluster, a keepalived pair). Each service stays judged by its own
template on its own host; a group adds what only shows across hosts. Rules:

- A service is in at most one group (`service_instances.group_id`, ON DELETE SET NULL); saving a group with a service moves
  it out of any other.
- **Quorum**: at least `min_healthy` members WORKING (status up or degraded AND read within max(3 intervals, 3 minutes):
  `memberIsStale`); blank = all of them. A switched-off service, or one on a switched-off host, is not counted at all, and a
  group with nobody counted is `unknown` with nothing judged (what it had open is resolved).
- **Role** (optional): how many working members report a state metric with a value (`role` = `MASTER`), between a fewest and
  a most. Offered only for a state metric EVERY member's template has (`commonStateMetrics`; the API refuses others, since
  a member that cannot report it would count as "not MASTER" for ever). Judged only while the quorum holds (no "no MASTER" on
  top of "too few working").
- A breach that lasts `for_sec` opens a `monitor_incident` with `service_group_id` set and `rule_id` `group:quorum` /
  `group:role`, so acknowledging, escalation (it joins the group for the name and link), alert channels, maintenance mode and
  the assistant's acknowledge card apply. Notices are `infra.alert.opened/resolved` to the monitoring recipients, link
  `/monitoring/infra/service-groups/<id>`; `alerts` off records but tells nobody. Activity `resourceType` `service_group`.
- **One open incident per group and rule is the database's rule**: a unique index on `(service_group_id, group_open_rule)`,
  where `group_open_rule` is the rule id while open and NULL once resolved. Not a partial index: CockroachDB refuses a
  partial index on a column added in the same transaction (found when the first version of 0087 failed to migrate). A
  23505 on open means another node opened it: adopt it, tell nobody again.
- The `service-groups` cluster job (30 s) is the only writer of a group's `status`, `alert_state` and `last_result`
  (volatile in the backup registry); the pages judge afresh from the members' readings and use the stored state only for
  "is an incident open".
- Reads `monitors:read:any`; writes `monitors:write:any`, audited `service.group.create|update|delete`; MCP read tools
  `service_groups_list`, `service_groups_get`, `service_groups_list_incidents` (writes and the role-choices helper excluded).

**Home page**: a sixth area, `services` (`AREA_KEYS`), only when at least one service or group exists (an install without
any gets no extra "not set up" row on every look). Counts are the switched-on services on switched-on hosts; a service down
or degraded, and a GROUP down or degraded, are problems of the area (since = the open incident's start). Front of House has a
`services` channel (services up of all, groups working); availability history samples kind `service_instance` (degraded
counts as up), so Glass and Toward Sunday show it.

**Tests (groups, wave two)**: `service-groups.test.ts` (the rules), `service-groups.integration.test.ts` (CockroachDB and
YugabyteDB: split brain opens ONE incident with two nodes judging at once, `for_sec`, quorum with a stale member, alerts off and
maintenance, refusals, moving and deleting), `service-templates-wave2.test.ts` (each new template on its fixture, the RESP
framing against a fake server, a password with a line break refused, opt-in real Redis), smoke "a group of services ...",
e2e "group services across hosts".

**Groups, part two** (2026-10-27, migration 0088):
- **A role read differently per template**: `role.byTemplate` maps a template key to the state and value that template
  reports for the role (Patroni `role` = `leader`, repmgr `node_role` = `primary`); a member whose template is not in the map
  uses `role.metric` / `role.value`, so rules saved before it read as before. `role.value` is then only the word the group
  shows. Saving is refused unless EVERY member's template reports the state the rule reads for it (`roleRuleProblem`).
  `GET .../groups/role-choices` now answers `{common, templates: [{key, name, metrics}]}`; the form shows the plain fields
  for one template and a row per template for several.
- **Redundancy warning** (`redundancy_after_min`, optional): a third check, `redundancy`, severity `warning`, breaching while
  some counted member is not working but the quorum holds, opened after ITS OWN minutes (`groupCheckForSec`), not the group's
  `for_sec`. Same incident path (`group:redundancy`, notice `infra.alert.opened` like an infra warning threshold). It never
  makes the group `down`.
- **Status page** (`show_on_status`, `status_name`): `StatusService` lists chosen groups beside monitors, by name only
  (never members, hosts or the reason): `down` while the job judged it down or a quorum/role incident is open (`since` = that
  incident's start), `up` when up or degraded (a lost spare still works: the redundancy incident is ignored here), otherwise
  `unknown`. The public status page gets the same items, as for monitors.
- **Search**: kind `service_group` (a DB-backed monitoring kind, `monitors:read:any`), title the name, body the description,
  url the group's page; picked up by the 120 s monitoring reconcile like services.
- **History**: the availability sampler records kind `service_group` each minute from the job's last status (degraded = up,
  unknown = nothing); it belongs to no home-page area (the members already count there) but the week's health strip reads
  every kind. The group's page shows the share working over the last day and week (`availability`).

**Not built**: alerts on a trend across a group's history (for example "down more than 1% this week"); a group holding uptime
monitors as well as services.

## 1. The idea

Do not write one checker per product. Write **one engine that runs templates**. A built-in service (HAProxy, Postgres,
...) is just a template shipped with the app; an admin's custom application is a template made in the GUI, in the same
format. The engine does the transport, parsing, rate maths, storage, alerting and display. A template only says *what to
ask, how to read the answer, which numbers matter and when to complain*.

## 2. Where it fits in the existing code

- The host side already exists: `infra_targets` (kind, credentials, SSH), `InfraCollector`
  (`apps/api/src/infra/infra-collector.ts`), `sshExec` (`collectors/ssh.ts`, TOFU host key, per-poll connection) and an
  on-demand **discover services** call (`POST /infra/targets/:id/discover-services`) that today lists running services.
  Discovery is the natural hook for `detect` (section 3): "HAProxy found on this host, enable monitoring?".
- Storage already has `infra_metric_samples` (jsonb `metrics`), `infra_metric_rollups` and `infra_entities`, with
  retention enforced in app code (raw 7d, 5m rollups 90d, 1h rollups 365d). Service readings should reuse the same
  retention and rollup pass rather than invent a second one.
- Alerts reuse `InfraThresholdRule`-style evaluation: a sustained breach opens/resolves a `monitor_incident` and fans out
  notifications, silenced by `monitoring.maintenance_mode`.
- Permissions stay on the `monitoring` module (`monitors:read:any` / `monitors:write:any`), like cisco, ipam, ups, dns.
  No new module.

## 3. Template format

A template is a document (YAML for humans, stored as validated JSON; the Zod schema lives in `packages/shared`) with
five parts:

1. **detect**: how to tell a host runs the service (systemd unit, listening port, docker container name, process). Used
   by discovery to suggest the template. Advisory only: an admin can attach any template to any host.
2. **inputs**: fields the admin fills in per instance (port, stats URL, socket path, database user and password, API
   token, TLS verify). Typed (`string`, `number`, `secret`, `bool`, `select`); `secret` values are encrypted like
   `infra_target_credentials` and never returned by the API.
3. **collect**: named collectors. Each has a **transport**, the request, and a **parser**.
4. **metrics**: named values derived from collector output: `gauge`, `counter` (the engine turns it into a rate; the
   template never does the maths) or `state` (enum, e.g. VRRP MASTER/BACKUP/FAULT), with unit and aggregation.
5. **checks and layout**: default alert rules (expression, severity, "for N seconds", message text) and which cards,
   charts and tables the instance page shows.

```yaml
id: haproxy
name: HAProxy
detect: { unit: haproxy, port: 8404 }
inputs:
  - { key: stats_url, label: Stats URL, type: string, default: "http://127.0.0.1:8404/stats;csv" }
collect:
  stats: { transport: http, url: "{{stats_url}}", parse: csv }
metrics:
  backend_down: { from: stats, where: "svname=='BACKEND' && status!='UP'", agg: count }
  sessions_cur: { from: stats, field: scur, where: "svname=='FRONTEND'", agg: sum }
  resp_ms:      { from: stats, field: rtime, where: "svname=='BACKEND'", agg: max, unit: ms }
  err_5xx_rate: { from: stats, field: hrsp_5xx, kind: counter, agg: sum }
checks:
  - { expr: "backend_down > 0", severity: critical, for: 60s, text: "{{backend_down}} backend(s) down" }
```

### Transports (a closed list; shell is the last resort)

| Transport | Used for |
|---|---|
| `prometheus` (scrape text format) | CockroachDB `/_status/vars`, YugabyteDB, Garage, Caddy, Traefik, RabbitMQ, etcd, and most custom apps. The highest-value transport. |
| `http` + JSON/CSV/text | HAProxy stats CSV, Kea Control Agent, Technitium API, Apache `mod_status?auto`, Elasticsearch/OpenSearch |
| `sql` | MariaDB/MySQL, PostgreSQL, YugabyteDB YSQL: a list of read-only queries over the wire protocol with a monitoring login |
| `ssh` | The escape hatch: `systemctl is-active`, HAProxy's admin socket via `socat`, VRRP state, log greps. Reuses `sshExec` and the host's stored login. |
| `snmp`, `tcp` | Reuse the existing code |

Parsers are a closed list too: `json` (JSONPath), `csv`, `prometheus`, `kv`, `regex`, `lines`.

### Expression language

`where`, `expr` and derived metrics use a **sandboxed, non-Turing-complete expression language** (JSONata or CEL; pick
one in phase 0 and do not mix). Never `eval`, never user JavaScript. This is what makes GUI-authored templates safe.

## 4. Data model (sketch)

Expand/contract applies (migrations must work with the previous release). All additive:

- `service_templates` (id, key, name, version, source `builtin|custom`, `forked_from`, body jsonb, `allows_commands`
  bool, timestamps). Built-ins are shipped in code (`packages/shared`) and seeded/read, never edited; a custom copy is a
  fork.
- `service_instances` (id, target_id -> `infra_targets`, template_key, name, inputs jsonb, secrets encrypted, enabled,
  status, last_error, last_polled_at, `claimed`-style fields if the poll is sharded later).
- Readings: either new columns/rows alongside `infra_metric_samples`, or a sibling `service_metric_samples`
  (instance_id, metric_key, label, ts, value) with the same rollup/prune pass. Decide in phase 0 against the rollup code.
  **Cardinality cap per template** (aggregate by default; per-backend/per-server detail only for the top N) or HAProxy
  with many servers makes the table grow fast.
- Service members shown as `infra_entities` (for example each HAProxy backend) so they are searchable and link to the
  parent host, the same as Docker containers today.
- Backup registry (`backup/table-registry.ts`): templates and instances are `data` (secrets `sensitive`), readings and
  status are `skip`/`volatile`. The registry unit test fails otherwise.
- Search: add `service_instance` (and optionally `service_template`) as `SearchKind`s with the `monitors:read:any` gate.

## 5. Execution and cluster rules

- Polling runs through `ClusterJobs.register(...)` (never a bare timer); counter baselines and alert state live in
  `job_state`, not a `Map`, so a handover keeps rates correct.
- Honour maintenance mode for notifications (incidents are still recorded) and the restore gate for any background write.
- Per-instance timeout and concurrency cap; a slow or hung service costs only its own instance. A failing collector marks
  the instance `down` with `last_error` (credentials saved under another `AUTH_SECRET` fail loudly via
  `decryptStoredSecret`, as elsewhere).
- Reads of "current value" must say how old they are; an unreachable instance records nothing (no data), never zeros.

## 6. Security (decide deliberately)

A template that can run SSH commands is remote command execution as the monitoring login on every host it is attached
to. Rules:

- Only `monitors:write:any` (admin tier) may create or edit a template or instance.
- A template containing any `ssh` collector has `allows_commands = true`; saving or enabling one needs an explicit
  confirmation, shows a diff against the previous version, and writes an audit entry. Commands are fixed text with
  `{{input}}` substitution that is **shell-quoted by the engine**, never string-concatenated, and read-only by
  convention (review aid, not a sandbox).
- Built-in templates are read-only; customising means forking.
- Prefer read-only logins and tokens everywhere. A template declares what it needs ("needs `pg_monitor`"), and the GUI
  shows it next to the inputs.
- Sudo: a command that needs root is declared (`sudo: true`) and goes through the existing sudo probe rules
  (`infra/sudo-access.ts`); it is never silently elevated.
- **MCP:** template create/edit/run are excluded from the MCP bridge (`route-rules.ts`, `excluded` with this reason).
  Reading templates, instances and readings can be tools. Anything that triggers a poll on live equipment is
  `@OperationalOnly()`.
- Audit: every template and instance write goes through the audit interceptor. Poller-triggered activity is not HTTP, so
  it follows the existing pattern (a run table or ledger), not the interceptor.

## 7. GUI

- **Service tab on the host page**: instances with status, key metrics, charts, member table (backends, replicas,
  zones), open incidents; "Add service" offers detected templates first, then the full catalogue.
- **Template editor** (admin): YAML and a form view side by side, with validation as you type.
- **Test button** (the most important authoring feature): runs the template against a chosen host with the entered inputs
  and shows, in order, the raw output, the parsed result, the computed metrics, and which checks would fire. No save
  required.
- Import and export as YAML so templates can be kept in the wiki or git.
- Built-ins show their YAML read-only with a "Fork to customise" button.
- Built-in templates ship with **fixture tests** (captured sample HAProxy CSV, `pg_stat_replication` rows, Kea JSON,
  and so on) run in `apps/api/test/`, the same style as the pure-function tests elsewhere.

## 8. Catalogue

First wave (the original ask): HAProxy, keepalived, MariaDB/MySQL, PostgreSQL, YugabyteDB, CockroachDB, Apache2, Kea
DHCP, Technitium DNS (reusing `dns/technitium.ts` ideas).

Suggested next: Redis/Valkey, nginx, Caddy, Postfix queue depth, chrony/NTP drift, ZFS/mdadm/SMART health, systemd
failed units, Samba/Active Directory, CUPS, Proxmox Backup Server, Galera (`wsrep_*`), Patroni, pgBouncer, etcd,
RabbitMQ, Garage, Meilisearch.

**Generic templates for custom applications** (probably worth more than any single built-in): Prometheus endpoint, JSON
HTTP endpoint, "systemd unit + port + log pattern", and "SQL query returns a number".

Related gap noticed while designing: `tls` is in `MONITOR_KINDS` but the `services/monitor` worker has no probe for it
(it reports `unknown kind`). A certificate-expiry probe is a small separate win and could ship first.

## 9. Proposed decisions and open questions

| # | Question | Proposed answer |
|---|---|---|
| 1 | Agentless only, or an optional host agent later? | **Agentless** (SSH/HTTP/SQL from the dashboard). A host agent is a large extra surface; revisit only on an explicit ask. |
| 2 | Credentials per instance, or shared sets? | Allow **named credential sets** that instances reference (one `monitor` DB login for all Postgres servers), plus per-instance override. |
| 3 | Failing checks open a normal `monitor_incident`? | **Yes**, severities mapped onto the existing levels, same fan-out and maintenance-mode behaviour as infra thresholds. |
| 4 | One "service group" view across hosts (a Cockroach cluster, a HAProxy + keepalived pair)? | **Defer**, but keep the data model able to add a group id later. Per-host first. |
| 5 | Expression language | JSONata or CEL: pick in phase 0 after trying both against the HAProxy and Postgres templates. |
| 6 | Readings storage | Reuse `infra_metric_samples` or a sibling table: decide in phase 0 against the rollup code. |

Honest trade-off: this resembles Zabbix templates / Telegraf plugins. The reason to build it here is that results land in
incidents, permissions, maintenance mode, search and the home-page "needs you" with no glue. If only graphs were wanted,
scraping with Prometheus would be less work.

## 10. Phasing

0. **Spike:** choose the expression language and storage shape; build the engine for one template end to end (HAProxy over
   `http`) with the test button, to prove the format.
1. **Engine + core transports** (`prometheus`, `http`, `ssh`), instances on a host page, metrics storage + rollups +
   retention, checks -> incidents, the Test button, fixture tests. Ship HAProxy and keepalived.
2. **Databases:** add the `sql` transport (read-only, own pool/timeouts, never the app's database pool); CockroachDB and
   YugabyteDB (Prometheus plus a few SQL checks), PostgreSQL, MariaDB/MySQL.
3. **Network services:** Technitium, Kea, Apache, then the generic templates (Prometheus endpoint, JSON endpoint, systemd
   + port + log pattern, SQL number).
4. **Authoring GUI:** editor, import/export, fork-from-built-in, the `allows_commands` approval flow. Full custom
   authoring comes last, once the format has proven itself on the built-ins.
5. Later: service groups, MCP read tools, catalogue wave two, home-page snapshot section (`services`) with
   permission-gated builder.

## 11. Rules for whoever builds it

- Portable SQL only (CockroachDB and YugabyteDB); migrations additive; every table gets a backup-registry decision.
- No bare timers: `ClusterJobs`; baselines in `job_state`.
- Open database pools for the `sql` transport only through `createPool` from `@church/shared/db`, with a client-side query
  timeout and a read-only login; never reuse the app's own pool for monitored databases.
- No `any`; Zod schemas in `packages/shared` for the template format and every route.
- Update `CLAUDE.md` (Access control / monitoring section) and `docs/infrastructure-monitoring.md` when it ships.
