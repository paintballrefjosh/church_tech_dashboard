# Service monitoring (templates): design

Status: **designed, not built** (written 2026-10-15). Nothing in this document exists in the code yet. It records the
idea, the proposed decisions, the open questions and the phasing, so it can be implemented later without re-deriving
them. Items marked **proposed** were recommended in discussion but not yet confirmed by the owner.

In-depth monitoring of the *services running on* an infrastructure host (HAProxy, databases, DHCP, DNS ...), beyond what
[infrastructure-monitoring.md](infrastructure-monitoring.md) already does (CPU, memory, disk, network, Docker containers,
Proxmox guests). Examples: for HAProxy, frontends/backends down, session counts, response time, 5xx rate; for a database,
cluster health, replication lag, connections, read/write latency, errors.

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
