import type { ServiceTemplateBody } from "./template";

/**
 * The templates that ship with the app (docs/service-monitoring.md section 8). Read-only: customising one means forking it
 * into a custom template. Each is tested against output captured from the real software where that was possible (see
 * apps/api/test/fixtures/service-monitoring/ and which file says it was captured and which was written from the vendor's
 * documentation).
 *
 * `BUILTIN_TEMPLATE_VERSION` goes up when any built-in changes, so an instance page can say "the template changed".
 */
export const BUILTIN_TEMPLATE_VERSION = 3;

const port = (def: number) => ({ key: "port", label: "Port", type: "number" as const, default: def });
const verify = { key: "verify_tls", label: "Check the TLS certificate", type: "bool" as const, default: true, help: "Turn off for a self-signed certificate." };

const haproxy: ServiceTemplateBody = {
  name: "HAProxy",
  description: "Frontends and backends from HAProxy's stats page (CSV): backends down, servers down, sessions, response time, errors.",
  needs: "A stats page: `stats enable` and `stats uri /stats` on a frontend (the CSV is the same address with ;csv).",
  detect: { units: ["haproxy"], ports: [8404] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(8404),
    { key: "path", label: "Stats address", type: "string", default: "/stats;csv", help: "Ends in ;csv." },
    { key: "user", label: "Stats user (if the page has one)", type: "string", default: "" },
    { key: "password", label: "Stats password", type: "secret" },
    verify,
  ],
  collect: {
    stats: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{port}}{{path}}",
      auth: { user: "{{user}}", password: "{{password}}" },
      verifyTls: "{{verify_tls}}",
      parse: { type: "csv" },
    },
  },
  metrics: {
    backends_down: { label: "Backends down", from: "stats", where: "svname == 'BACKEND' && status != 'UP'", agg: "count" },
    servers_down: {
      label: "Servers down",
      from: "stats",
      where: "svname != 'BACKEND' && svname != 'FRONTEND' && startsWith(status, 'DOWN')",
      agg: "count",
    },
    sessions: { label: "Sessions now", from: "stats", where: "svname == 'FRONTEND'", field: "scur", agg: "sum" },
    request_rate: { label: "Requests per second", from: "stats", where: "svname == 'FRONTEND'", field: "req_rate", agg: "sum", unit: "/s" },
    response_ms: { label: "Slowest backend (avg response)", from: "stats", where: "svname == 'BACKEND'", field: "rtime", agg: "max", unit: "ms" },
    errors_5xx: { label: "5xx answers per second", from: "stats", where: "svname == 'FRONTEND'", field: "hrsp_5xx", agg: "sum", kind: "counter", unit: "/s" },
  },
  members: {
    label: "Backends",
    from: "stats",
    where: "svname == 'BACKEND'",
    key: "pxname",
    ok: "status == 'UP'",
    columns: { status: "status", sessions: "scur", "response ms": "rtime", "servers up": "act" },
  },
  checks: [
    { id: "backend_down", expr: "backends_down > 0", severity: "critical", for: 60, text: "{{backends_down}} backend(s) down" },
    { id: "server_down", expr: "servers_down > 0", severity: "warning", for: 120, text: "{{servers_down}} server(s) down" },
    { id: "errors", expr: "errors_5xx > 1", severity: "warning", for: 300, text: "{{errors_5xx}} 5xx answers per second" },
  ],
  display: {
    cards: ["backends_down", "servers_down", "sessions", "request_rate", "response_ms"],
    charts: [
      { title: "Sessions and requests", metrics: ["sessions", "request_rate"] },
      { title: "Slowest backend", metrics: ["response_ms"] },
      { title: "5xx answers", metrics: ["errors_5xx"] },
    ],
  },
};

const keepalived: ServiceTemplateBody = {
  name: "keepalived",
  description: "Whether keepalived runs and whether this host holds the virtual address (MASTER) or not (BACKUP).",
  needs: "The host's SSH login; nothing needs root.",
  detect: { units: ["keepalived"] },
  inputs: [
    { key: "vip", label: "Virtual IP address", type: "string", required: true },
    { key: "expect_role", label: "This host should be", type: "select", options: ["either", "MASTER", "BACKUP"], default: "either" },
  ],
  collect: {
    state: {
      transport: "ssh",
      command: "systemctl is-active keepalived; ip -o addr show | grep -cF -- {{vip}} || true",
      parse: { type: "lines" },
    },
  },
  metrics: {
    running: { label: "Running", from: "state", where: "n == 1 && line == 'active'", agg: "count" },
    has_vip: { label: "Holds the virtual address", from: "state", where: "n == 2", field: "line", agg: "first" },
    role: { label: "Role", expr: "has_vip > 0 ? 'MASTER' : 'BACKUP'", kind: "state" },
  },
  checks: [
    { id: "not_running", expr: "running == 0", severity: "critical", for: 30, text: "keepalived is not running" },
    {
      id: "wrong_role",
      expr: "inputs.expect_role != 'either' && role != inputs.expect_role",
      severity: "warning",
      for: 120,
      text: "This host is {{role}}",
    },
  ],
  display: { cards: ["running", "role"] },
};

const postgres: ServiceTemplateBody = {
  name: "PostgreSQL",
  description: "Connections, commits and rollbacks, deadlocks, long-idle transactions, and replication (as a primary or a standby).",
  needs: "A login with the pg_monitor role (CREATE ROLE monitor LOGIN PASSWORD '...' IN ROLE pg_monitor). Everything runs in a read-only transaction.",
  detect: { units: ["postgresql"], ports: [5432] },
  inputs: [
    port(5432),
    { key: "database", label: "Database", type: "string", default: "postgres" },
    { key: "login", label: "Login", type: "login", required: true },
    { key: "tls", label: "Use TLS", type: "bool", default: false },
  ],
  collect: {
    stats: {
      transport: "sql",
      engine: "postgres",
      port: "{{port}}",
      database: "{{database}}",
      user: "{{login.user}}",
      password: "{{login.password}}",
      tls: "{{tls}}",
      query: `SELECT
  (SELECT count(*) FROM pg_stat_activity) AS connections,
  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
  (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active,
  (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction' AND now() - state_change > interval '5 minutes') AS long_idle_tx,
  (SELECT sum(xact_commit) FROM pg_stat_database) AS commits,
  (SELECT sum(xact_rollback) FROM pg_stat_database) AS rollbacks,
  (SELECT sum(deadlocks) FROM pg_stat_database) AS deadlocks,
  pg_is_in_recovery() AS in_recovery,
  CASE WHEN pg_is_in_recovery() THEN extract(epoch FROM now() - pg_last_xact_replay_timestamp()) END AS standby_lag_s`,
    },
    replicas: {
      transport: "sql",
      engine: "postgres",
      port: "{{port}}",
      database: "{{database}}",
      user: "{{login.user}}",
      password: "{{login.password}}",
      tls: "{{tls}}",
      query: "SELECT application_name, coalesce(client_addr::text, 'local') AS client, state, coalesce(extract(epoch FROM replay_lag), 0) AS replay_lag_s FROM pg_stat_replication",
    },
  },
  metrics: {
    connections: { label: "Connections", from: "stats", field: "connections" },
    max_connections: { label: "Connection limit", from: "stats", field: "max_connections" },
    connections_pct: { label: "Connections used", expr: "connections / max_connections * 100", unit: "%" },
    active: { label: "Running queries", from: "stats", field: "active" },
    long_idle_tx: { label: "Transactions idle over 5 minutes", from: "stats", field: "long_idle_tx" },
    commits: { label: "Commits per second", from: "stats", field: "commits", kind: "counter", unit: "/s" },
    rollbacks: { label: "Rollbacks per second", from: "stats", field: "rollbacks", kind: "counter", unit: "/s" },
    deadlocks: { label: "Deadlocks per second", from: "stats", field: "deadlocks", kind: "counter", unit: "/s" },
    role: { label: "Role", from: "stats", value: "in_recovery ? 'standby' : 'primary'", kind: "state" },
    standby_lag_s: { label: "Standby behind by", from: "stats", field: "standby_lag_s", unit: "s" },
    replicas: { label: "Standbys connected", from: "replicas", agg: "count" },
    replica_lag_s: { label: "Slowest standby", from: "replicas", field: "replay_lag_s", agg: "max", unit: "s" },
  },
  members: {
    label: "Standbys",
    from: "replicas",
    key: "client",
    name: "application_name",
    ok: "state == 'streaming'",
    columns: { state: "state", "behind (s)": "round(replay_lag_s, 1)" },
  },
  checks: [
    { id: "connections", expr: "connections_pct > 85", severity: "warning", for: 300, text: "{{connections_pct}}% of connections in use" },
    { id: "standby_lag", expr: "role == 'standby' && standby_lag_s > 300", severity: "warning", for: 300, text: "The standby is {{standby_lag_s}} s behind" },
    { id: "replica_lag", expr: "replica_lag_s > 60", severity: "warning", for: 300, text: "A standby is {{replica_lag_s}} s behind" },
    { id: "idle_tx", expr: "long_idle_tx > 0", severity: "warning", for: 600, text: "{{long_idle_tx}} transaction(s) idle for over 5 minutes" },
  ],
  display: {
    cards: ["connections_pct", "active", "commits", "role", "replicas"],
    charts: [
      { title: "Connections", metrics: ["connections", "active"] },
      { title: "Transactions per second", metrics: ["commits", "rollbacks"] },
      { title: "Replication lag", metrics: ["standby_lag_s", "replica_lag_s"] },
    ],
  },
};

const mysql: ServiceTemplateBody = {
  name: "MariaDB / MySQL",
  description: "Connections, queries, slow queries, refused connections, replication and Galera cluster state.",
  needs: "A login with PROCESS and REPLICATION CLIENT (MariaDB: BINLOG MONITOR / REPLICA MONITOR on 10.5+). Read-only transaction.",
  detect: { units: ["mariadb", "mysql", "mysqld"], ports: [3306] },
  inputs: [port(3306), { key: "login", label: "Login", type: "login", required: true }, { key: "tls", label: "Use TLS", type: "bool", default: false }],
  collect: {
    status: {
      transport: "sql",
      engine: "mysql",
      port: "{{port}}",
      user: "{{login.user}}",
      password: "{{login.password}}",
      tls: "{{tls}}",
      query: "SHOW GLOBAL STATUS",
    },
    variables: {
      transport: "sql",
      engine: "mysql",
      port: "{{port}}",
      user: "{{login.user}}",
      password: "{{login.password}}",
      tls: "{{tls}}",
      query: "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections', 'version')",
    },
    replica: {
      transport: "sql",
      engine: "mysql",
      port: "{{port}}",
      user: "{{login.user}}",
      password: "{{login.password}}",
      tls: "{{tls}}",
      query: "SHOW REPLICA STATUS",
      // Older servers say SHOW SLAVE STATUS and refuse this; the rest of the template still works.
      optional: true,
    },
  },
  metrics: {
    connections: { label: "Connections", from: "status", where: "Variable_name == 'Threads_connected'", field: "Value" },
    running: { label: "Running threads", from: "status", where: "Variable_name == 'Threads_running'", field: "Value" },
    max_connections: { label: "Connection limit", from: "variables", where: "Variable_name == 'max_connections'", field: "Value" },
    connections_pct: { label: "Connections used", expr: "connections / max_connections * 100", unit: "%" },
    queries: { label: "Queries per second", from: "status", where: "Variable_name == 'Questions'", field: "Value", kind: "counter", unit: "/s" },
    slow_queries: { label: "Slow queries per second", from: "status", where: "Variable_name == 'Slow_queries'", field: "Value", kind: "counter", unit: "/s" },
    aborted_connects: { label: "Refused connections per second", from: "status", where: "Variable_name == 'Aborted_connects'", field: "Value", kind: "counter", unit: "/s" },
    uptime_s: { label: "Up for", from: "status", where: "Variable_name == 'Uptime'", field: "Value", unit: "s" },
    galera_size: { label: "Galera nodes", from: "status", where: "Variable_name == 'wsrep_cluster_size'", field: "Value" },
    galera_state: { label: "Galera state", from: "status", where: "Variable_name == 'wsrep_local_state_comment'", field: "Value", kind: "state" },
    replica_configured: { label: "Is a replica", from: "replica", agg: "count" },
    replica_io: { label: "Replica IO thread", from: "replica", value: "coalesce(Replica_IO_Running, Slave_IO_Running)", kind: "state" },
    replica_sql: { label: "Replica SQL thread", from: "replica", value: "coalesce(Replica_SQL_Running, Slave_SQL_Running)", kind: "state" },
    replica_lag_s: { label: "Replica behind by", from: "replica", value: "coalesce(Seconds_Behind_Source, Seconds_Behind_Master)", unit: "s" },
  },
  checks: [
    { id: "connections", expr: "connections_pct > 85", severity: "warning", for: 300, text: "{{connections_pct}}% of connections in use" },
    { id: "replica_stopped", expr: "replica_configured > 0 && (replica_io != 'Yes' || replica_sql != 'Yes')", severity: "critical", for: 60, text: "Replication stopped (IO {{replica_io}}, SQL {{replica_sql}})" },
    { id: "replica_lag", expr: "replica_lag_s > 300", severity: "warning", for: 300, text: "The replica is {{replica_lag_s}} s behind" },
    { id: "galera", expr: "galera_state != null && galera_state != 'Synced'", severity: "critical", for: 60, text: "Galera node is {{galera_state}}" },
  ],
  display: {
    cards: ["connections_pct", "queries", "slow_queries", "galera_size", "replica_lag_s"],
    charts: [
      { title: "Connections", metrics: ["connections", "running"] },
      { title: "Queries per second", metrics: ["queries", "slow_queries"] },
    ],
  },
};

const cockroach: ServiceTemplateBody = {
  name: "CockroachDB",
  description: "Unavailable and under-replicated ranges, live nodes, SQL connections and errors, disk space, clock offset, from one node's metrics.",
  needs: "The node's HTTP port (8080). A secure cluster serves it over https with the cluster's own certificate.",
  detect: { units: ["cockroach", "cockroachdb"], ports: [26257, 8080] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["https", "http"], default: "https" },
    port(8080),
    { ...verify, default: false, help: "The cluster's own CA is not trusted by the dashboard; leave off unless the certificate is public." },
  ],
  collect: {
    vars: {
      transport: "prometheus",
      url: "{{scheme}}://{{host}}:{{port}}/_status/vars",
      verifyTls: "{{verify_tls}}",
      keep: ["ranges", "liveness_", "sql_conns", "sql_query_count", "sql_failure_count", "capacity", "clock_offset_meannanos", "sys_uptime", "sys_cpu_combined_percent_normalized"],
    },
  },
  metrics: {
    ranges_unavailable: { label: "Unavailable ranges", from: "vars", where: "__name__ == 'ranges_unavailable'", field: "value", agg: "sum" },
    ranges_underreplicated: { label: "Under-replicated ranges", from: "vars", where: "__name__ == 'ranges_underreplicated'", field: "value", agg: "sum" },
    live_nodes: { label: "Live nodes", from: "vars", where: "__name__ == 'liveness_livenodes'", field: "value", agg: "max" },
    sql_conns: { label: "SQL connections", from: "vars", where: "__name__ == 'sql_conns'", field: "value", agg: "sum" },
    queries: { label: "Queries per second", from: "vars", where: "__name__ == 'sql_query_count'", field: "value", agg: "sum", kind: "counter", unit: "/s" },
    failures: { label: "Failed queries per second", from: "vars", where: "__name__ == 'sql_failure_count'", field: "value", agg: "sum", kind: "counter", unit: "/s" },
    capacity: { from: "vars", where: "__name__ == 'capacity'", field: "value", agg: "sum" },
    available: { from: "vars", where: "__name__ == 'capacity_available'", field: "value", agg: "sum" },
    disk_used_pct: { label: "Disk used", expr: "(capacity - available) / capacity * 100", unit: "%" },
    clock_offset_ms: { label: "Clock offset", from: "vars", where: "__name__ == 'clock_offset_meannanos'", value: "abs(value) / 1000000", agg: "max", unit: "ms" },
    cpu_pct: { label: "CPU", from: "vars", where: "__name__ == 'sys_cpu_combined_percent_normalized'", value: "value * 100", agg: "max", unit: "%" },
  },
  checks: [
    { id: "unavailable", expr: "ranges_unavailable > 0", severity: "critical", for: 60, text: "{{ranges_unavailable}} range(s) unavailable" },
    { id: "underreplicated", expr: "ranges_underreplicated > 0", severity: "warning", for: 600, text: "{{ranges_underreplicated}} range(s) under-replicated" },
    { id: "disk", expr: "disk_used_pct > 85", severity: "warning", for: 600, text: "Disk {{disk_used_pct}}% full" },
    { id: "clock", expr: "clock_offset_ms > 250", severity: "warning", for: 300, text: "Clock {{clock_offset_ms}} ms off the cluster" },
  ],
  display: {
    cards: ["ranges_unavailable", "ranges_underreplicated", "live_nodes", "sql_conns", "disk_used_pct"],
    charts: [
      { title: "Queries per second", metrics: ["queries", "failures"] },
      { title: "SQL connections", metrics: ["sql_conns"] },
      { title: "Disk used", metrics: ["disk_used_pct"] },
    ],
  },
};

const yugabyte: ServiceTemplateBody = {
  name: "YugabyteDB",
  description: "Dead nodes and under-replicated tablets from the master, each tablet server's heartbeat and disk, plus RPC connections and clock skew.",
  needs: "The master's web port (7000) and the tablet server's (9000), reachable from the dashboard.",
  detect: { units: ["yb-master", "yb-tserver", "yugabyted"], ports: [7000, 9000, 5433] },
  inputs: [
    { key: "master_port", label: "Master web port", type: "number", default: 7000 },
    { key: "tserver_port", label: "Tablet server web port", type: "number", default: 9000 },
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    { ...verify, default: false },
  ],
  collect: {
    dead: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{master_port}}/api/v1/health-check",
      verifyTls: "{{verify_tls}}",
      parse: { type: "json", rows: "dead_nodes" },
    },
    under: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{master_port}}/api/v1/health-check",
      verifyTls: "{{verify_tls}}",
      parse: { type: "json", rows: "under_replicated_tablets" },
    },
    servers: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{master_port}}/api/v1/tablet-servers",
      verifyTls: "{{verify_tls}}",
      parse: { type: "json", rows: "*.*" },
    },
    tserver: {
      transport: "prometheus",
      // Ask for these names only: the whole page lists every table and tablet (1.2 MB on an empty node), past the 5 MB cap on a
      // real cluster. The server matches loosely, so `keep` still picks the exact names. Measured on 2024.2.
      url: "{{scheme}}://{{host}}:{{tserver_port}}/prometheus-metrics?metrics=rpc_connections_alive,hybrid_clock_skew,server_uptime_ms,follower_lag_ms&show_help=false",
      verifyTls: "{{verify_tls}}",
      keep: ["rpc_connections_alive", "hybrid_clock_skew", "server_uptime_ms", "follower_lag_ms"],
      optional: true,
    },
  },
  metrics: {
    dead_nodes: { label: "Dead nodes", from: "dead", agg: "count" },
    under_replicated: { label: "Under-replicated tablets", from: "under", agg: "count" },
    tservers: { label: "Tablet servers", from: "servers", agg: "count" },
    tservers_alive: { label: "Tablet servers alive", from: "servers", where: "status == 'ALIVE'", agg: "count" },
    slowest_heartbeat_s: { label: "Oldest heartbeat", from: "servers", field: "time_since_hb_sec", agg: "max", unit: "s" },
    rpc_connections: { label: "RPC connections (this tablet server)", from: "tserver", where: "__name__ == 'rpc_connections_alive'", field: "value", agg: "max" },
    clock_skew_ms: { label: "Clock skew", from: "tserver", where: "__name__ == 'hybrid_clock_skew'", value: "value / 1000", agg: "max", unit: "ms" },
    follower_lag_ms: { label: "Worst follower lag", from: "tserver", where: "__name__ == 'follower_lag_ms'", field: "value", agg: "max", unit: "ms" },
  },
  members: {
    label: "Tablet servers",
    from: "servers",
    key: "_key",
    ok: "status == 'ALIVE'",
    columns: {
      status: "status",
      "heartbeat (s)": "round(time_since_hb_sec, 1)",
      "up (h)": "round(uptime_seconds / 3600, 1)",
      "tablet leaders": "user_tablets_leaders",
    },
  },
  checks: [
    { id: "dead_nodes", expr: "dead_nodes > 0", severity: "critical", for: 60, text: "{{dead_nodes}} node(s) dead" },
    { id: "under_replicated", expr: "under_replicated > 0", severity: "warning", for: 600, text: "{{under_replicated}} tablet(s) under-replicated" },
    { id: "heartbeat", expr: "slowest_heartbeat_s > 30", severity: "warning", for: 120, text: "A tablet server last checked in {{slowest_heartbeat_s}} s ago" },
  ],
  display: {
    cards: ["dead_nodes", "under_replicated", "tservers_alive", "rpc_connections", "clock_skew_ms"],
    charts: [
      { title: "RPC connections", metrics: ["rpc_connections"] },
      { title: "Follower lag", metrics: ["follower_lag_ms"] },
    ],
  },
};

const apache: ServiceTemplateBody = {
  name: "Apache httpd",
  description: "Busy and idle workers, requests and traffic per second, from mod_status.",
  needs: "mod_status with a <Location /server-status> the dashboard may read (Require ip <dashboard>).",
  detect: { units: ["apache2", "httpd"], ports: [80] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(80),
    { key: "path", label: "Status address", type: "string", default: "/server-status?auto" },
    verify,
  ],
  collect: {
    status: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}{{path}}", verifyTls: "{{verify_tls}}", parse: { type: "kv", separator: ": " } },
  },
  metrics: {
    busy: { label: "Busy workers", from: "status", field: "BusyWorkers" },
    idle: { label: "Idle workers", from: "status", field: "IdleWorkers" },
    busy_pct: { label: "Workers busy", expr: "busy / (busy + idle) * 100", unit: "%" },
    requests: { label: "Requests per second", from: "status", field: "Total Accesses", kind: "counter", unit: "/s" },
    kbytes: { label: "kB per second", from: "status", field: "Total kBytes", kind: "counter", unit: "kB/s" },
    uptime_s: { label: "Up for", from: "status", field: "ServerUptimeSeconds", unit: "s" },
  },
  checks: [{ id: "no_idle", expr: "idle == 0", severity: "warning", for: 120, text: "No idle workers ({{busy}} busy)" }],
  display: {
    cards: ["busy", "idle", "requests", "kbytes"],
    charts: [
      { title: "Workers", metrics: ["busy", "idle"] },
      { title: "Requests per second", metrics: ["requests"] },
    ],
  },
};

const kea: ServiceTemplateBody = {
  name: "Kea DHCP",
  description: "Address pool use per subnet (DHCPv4) through the Kea Control Agent.",
  needs: "The Control Agent (port 8000) and the stat_cmds hook (libdhcp_stat_cmds.so) loaded in kea-dhcp4.",
  detect: { units: ["kea-ctrl-agent", "isc-kea-ctrl-agent", "kea-dhcp4", "isc-kea-dhcp4-server"], ports: [8000] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(8000),
    { key: "user", label: "Control Agent user (if set)", type: "string", default: "" },
    { key: "password", label: "Control Agent password", type: "secret" },
    verify,
  ],
  collect: {
    leases: {
      transport: "http",
      method: "POST",
      url: "{{scheme}}://{{host}}:{{port}}/",
      headers: { "content-type": "application/json" },
      body: '{"command": "stat-lease4-get", "service": ["dhcp4"]}',
      auth: { user: "{{user}}", password: "{{password}}" },
      verifyTls: "{{verify_tls}}",
      parse: { type: "json", rows: "[0].arguments.result-set.rows", columns: "[0].arguments.result-set.columns" },
    },
  },
  metrics: {
    subnets: { label: "Subnets", from: "leases", agg: "count" },
    total: { label: "Addresses", from: "leases", field: "total-addresses", agg: "sum" },
    assigned: { label: "Leased", from: "leases", field: "assigned-addresses", agg: "sum" },
    declined: { label: "Declined", from: "leases", field: "declined-addresses", agg: "sum" },
    fullest_pct: { label: "Fullest pool", from: "leases", value: "`assigned-addresses` / `total-addresses` * 100", agg: "max", unit: "%" },
  },
  members: {
    label: "Subnets",
    from: "leases",
    key: "subnet-id",
    name: "subnet-id",
    ok: "`assigned-addresses` / `total-addresses` < 0.9",
    columns: { addresses: "`total-addresses`", leased: "`assigned-addresses`", "used %": "round(`assigned-addresses` / `total-addresses` * 100, 1)", declined: "`declined-addresses`" },
  },
  checks: [
    { id: "pool_full", expr: "fullest_pct > 90", severity: "warning", for: 300, text: "A pool is {{fullest_pct}}% full" },
    { id: "declined", expr: "declined > 10", severity: "warning", for: 600, text: "{{declined}} addresses declined (an address conflict?)" },
  ],
  display: { cards: ["subnets", "assigned", "total", "fullest_pct"], charts: [{ title: "Leases", metrics: ["assigned", "declined"] }] },
};

const technitium: ServiceTemplateBody = {
  name: "Technitium DNS",
  description: "Queries, failures, blocked and cached answers in the last hour, from one Technitium server's dashboard.",
  needs: "An API token (Administration > Sessions > Create Token) with dashboard read access.",
  detect: { units: ["dns", "technitium"], ports: [5380, 53443] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(5380),
    { key: "token", label: "API token", type: "secret", required: true },
    verify,
  ],
  collect: {
    stats: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{port}}/api/dashboard/stats/get?type=LastHour&utc=true",
      headers: { authorization: "Bearer {{token}}" },
      verifyTls: "{{verify_tls}}",
      parse: { type: "json" },
    },
  },
  metrics: {
    status: { label: "API status", from: "stats", field: "status", kind: "state" },
    queries: { label: "Queries (last hour)", from: "stats", field: "response.stats.totalQueries" },
    server_failure: { label: "Server failures (last hour)", from: "stats", field: "response.stats.totalServerFailure" },
    failure_pct: { label: "Failed", expr: "queries > 0 ? server_failure / queries * 100 : 0", unit: "%" },
    blocked: { label: "Blocked (last hour)", from: "stats", field: "response.stats.totalBlocked" },
    cached: { label: "Answered from cache (last hour)", from: "stats", field: "response.stats.totalCached" },
    clients: { label: "Clients (last hour)", from: "stats", field: "response.stats.totalClients" },
  },
  checks: [
    { id: "api", expr: "status != 'ok'", severity: "critical", for: 60, text: "The server answered {{status}}" },
    { id: "failures", expr: "failure_pct > 5", severity: "warning", for: 600, text: "{{failure_pct}}% of queries failed" },
  ],
  display: {
    cards: ["queries", "failure_pct", "blocked", "clients"],
    charts: [{ title: "Last hour", metrics: ["queries", "server_failure", "blocked"] }],
  },
};

// Generic templates for an application nobody wrote a template for (section 8: probably worth more than any single one).

const genericPrometheus: ServiceTemplateBody = {
  name: "Prometheus endpoint (one metric)",
  description: "Any /metrics page: one metric, summed (or max) over its labels, with an optional limit.",
  inputs: [
    { key: "url", label: "Metrics address", type: "string", default: "http://{{host}}:9100/metrics", required: true, help: "{{host}} is the host's address." },
    { key: "metric", label: "Metric name", type: "string", required: true },
    { key: "label_filter", label: "Only samples whose labels contain (optional)", type: "string", default: "" },
    { key: "above", label: "Alert above (blank = never)", type: "string", default: "" },
    { key: "token", label: "Bearer token (if needed)", type: "secret" },
    { ...verify },
  ],
  collect: {
    metrics: { transport: "prometheus", url: "{{url}}", headers: { authorization: "Bearer {{token}}" }, verifyTls: "{{verify_tls}}" },
  },
  metrics: {
    value: { label: "Value", from: "metrics", where: "__name__ == inputs.metric && (inputs.label_filter == '' || contains(str(_labels), inputs.label_filter))", field: "value", agg: "sum" },
    samples: { label: "Samples", from: "metrics", where: "__name__ == inputs.metric", agg: "count" },
  },
  checks: [
    { id: "above", expr: "inputs.above != '' && value > num(inputs.above)", severity: "warning", for: 120, text: "Value {{value}}" },
    { id: "missing", expr: "samples == 0", severity: "warning", for: 300, text: "The metric is not on the page" },
  ],
  display: { cards: ["value", "samples"], charts: [{ title: "Value", metrics: ["value"] }] },
};

const genericJson: ServiceTemplateBody = {
  name: "JSON endpoint (one number)",
  description: "Any address that answers JSON: one value by its path, with an optional range.",
  inputs: [
    { key: "url", label: "Address", type: "string", required: true },
    { key: "path", label: "Path to the value", type: "string", required: true, help: "Like status.queue.depth or items[0].count." },
    { key: "above", label: "Alert above (blank = never)", type: "string", default: "" },
    { key: "below", label: "Alert below (blank = never)", type: "string", default: "" },
    { key: "token", label: "Bearer token (if needed)", type: "secret" },
    verify,
  ],
  collect: {
    data: { transport: "http", url: "{{url}}", headers: { authorization: "Bearer {{token}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json", rows: "{{path}}" } },
  },
  // The path picks one value; a value that is not an object becomes the row {value: ...}.
  metrics: { value: { label: "Value", from: "data", field: "value", agg: "first" } },
  checks: [
    { id: "above", expr: "inputs.above != '' && value > num(inputs.above)", severity: "warning", for: 120, text: "Value {{value}}" },
    { id: "below", expr: "inputs.below != '' && value < num(inputs.below)", severity: "warning", for: 120, text: "Value {{value}}" },
  ],
  display: { cards: ["value"], charts: [{ title: "Value", metrics: ["value"] }] },
};

const genericSystemd: ServiceTemplateBody = {
  name: "systemd unit, port and log pattern",
  description: "A unit is active, something listens on its port, and a text has not turned up in its log too often.",
  needs: "The host's SSH login (journalctl needs the systemd-journal group or root for other units' logs).",
  inputs: [
    { key: "unit", label: "Unit", type: "string", required: true },
    { key: "port", label: "TCP port it listens on (0 = do not check)", type: "number", default: 0 },
    { key: "pattern", label: "Log text to count", type: "string", default: "error" },
    { key: "minutes", label: "Over the last (minutes)", type: "number", default: 10 },
    { key: "max_matches", label: "Alert above this many matches", type: "number", default: 20 },
  ],
  collect: {
    state: {
      transport: "ssh",
      command:
        "systemctl is-active {{unit}}; if [ {{port}} -gt 0 ]; then ss -ltnH sport = :{{port}} | wc -l; else echo -1; fi; journalctl -u {{unit}} --since -{{minutes}}min --no-pager -q 2>/dev/null | grep -ciF -- {{pattern}} || true",
      parse: { type: "lines" },
    },
  },
  metrics: {
    active: { label: "Active", from: "state", where: "n == 1 && line == 'active'", agg: "count" },
    listeners: { label: "Listening sockets", from: "state", where: "n == 2", field: "line" },
    matches: { label: "Matching log lines", from: "state", where: "n == 3", field: "line" },
  },
  checks: [
    { id: "inactive", expr: "active == 0", severity: "critical", for: 30, text: "The unit is not active" },
    { id: "not_listening", expr: "listeners == 0", severity: "critical", for: 60, text: "Nothing listens on the port" },
    { id: "log", expr: "matches > inputs.max_matches", severity: "warning", for: 0, text: "{{matches}} matching log lines" },
  ],
  display: { cards: ["active", "listeners", "matches"], charts: [{ title: "Matching log lines", metrics: ["matches"] }] },
};

const genericSql: ServiceTemplateBody = {
  name: "SQL query returns a number",
  description: "A read-only query whose first column of the first row is a number (a queue length, rows waiting, the newest import's age).",
  needs: "A login that may run the query. It runs in a read-only transaction with a time limit.",
  inputs: [
    { key: "engine", label: "Database", type: "select", options: ["postgres", "mysql"], default: "postgres" },
    { key: "port", label: "Port", type: "number", default: 5432, help: "PostgreSQL 5432, MySQL/MariaDB 3306, CockroachDB 26257, YugabyteDB 5433." },
    { key: "database", label: "Database name", type: "string", default: "" },
    { key: "login", label: "Login", type: "login", required: true },
    { key: "query", label: "Query", type: "text", required: true, help: "SELECT count(*) FROM jobs WHERE state = 'waiting'" },
    { key: "above", label: "Alert above (blank = never)", type: "string", default: "" },
    { key: "tls", label: "Use TLS", type: "bool", default: false },
  ],
  collect: {
    q: {
      transport: "sql",
      engine: "{{engine}}",
      port: "{{port}}",
      database: "{{database}}",
      user: "{{login.user}}",
      password: "{{login.password}}",
      tls: "{{tls}}",
      query: "{{query}}",
    },
  },
  // Every sql row carries `_first`, its first column, so a query need not name it.
  metrics: { value: { label: "Value", from: "q", field: "_first", agg: "first" } },
  checks: [{ id: "above", expr: "inputs.above != '' && value > num(inputs.above)", severity: "warning", for: 120, text: "Value {{value}}" }],
  display: { cards: ["value"], charts: [{ title: "Value", metrics: ["value"] }] },
};

// Wave two (docs/service-monitoring.md section 0): the services a church's IT person runs next most often.

const redis: ServiceTemplateBody = {
  name: "Redis / Valkey",
  description: "Role (master or replica) and the replica's link, clients, memory, operations per second, evictions and the last save.",
  needs: "The port reachable from the dashboard; the password if `requirepass` is set (sent as AUTH, never in an address or a command line).",
  detect: { units: ["redis", "redis-server", "valkey", "valkey-server"], ports: [6379] },
  inputs: [
    port(6379),
    { key: "password", label: "Password (if set)", type: "secret" },
    { key: "expect_role", label: "This server should be", type: "select", options: ["either", "master", "replica"], default: "either" },
  ],
  collect: {
    info: { transport: "tcp", port: "{{port}}", redisAuth: "{{password}}", send: "INFO\\r\\n", parse: { type: "kv", separator: ":" } },
  },
  metrics: {
    version: { label: "Version", from: "info", field: "redis_version", kind: "state" },
    raw_role: { label: "Role as reported", from: "info", field: "role", kind: "state" },
    role: { label: "Role", expr: "raw_role == 'slave' ? 'replica' : raw_role", kind: "state" },
    link: { label: "Link to the master", from: "info", field: "master_link_status", kind: "state" },
    uptime_s: { label: "Up for", from: "info", field: "uptime_in_seconds", unit: "s" },
    clients: { label: "Clients", from: "info", field: "connected_clients" },
    blocked: { label: "Blocked clients", from: "info", field: "blocked_clients" },
    replicas: { label: "Replicas connected", from: "info", field: "connected_slaves" },
    used_mb: { label: "Memory used", from: "info", value: "num(used_memory) / 1048576", agg: "first", unit: "MB" },
    max_mb: { label: "Memory limit", from: "info", value: "num(maxmemory) / 1048576", agg: "first", unit: "MB" },
    memory_pct: { label: "Memory used of the limit", expr: "max_mb > 0 ? used_mb / max_mb * 100 : null", unit: "%" },
    ops: { label: "Operations per second", from: "info", field: "instantaneous_ops_per_sec", unit: "/s" },
    evicted: { label: "Keys evicted per second", from: "info", field: "evicted_keys", kind: "counter", unit: "/s" },
    rejected: { label: "Connections refused per second", from: "info", field: "rejected_connections", kind: "counter", unit: "/s" },
    save_status: { label: "Last save", from: "info", field: "rdb_last_bgsave_status", kind: "state" },
    aof_status: { label: "Last append-only write", from: "info", field: "aof_last_write_status", kind: "state" },
  },
  checks: [
    { id: "no_info", expr: "uptime_s == null", severity: "critical", for: 60, text: "No answer to INFO (a wrong or missing password?)" },
    { id: "link_down", expr: "role == 'replica' && link != 'up'", severity: "critical", for: 60, text: "The replica's link to its master is {{link}}" },
    { id: "save_failed", expr: "save_status != null && save_status != 'ok'", severity: "warning", for: 0, text: "The last save failed ({{save_status}})" },
    { id: "aof_failed", expr: "aof_status != null && aof_status != 'ok'", severity: "warning", for: 0, text: "The last append-only write failed ({{aof_status}})" },
    { id: "memory", expr: "memory_pct > 90", severity: "warning", for: 300, text: "{{memory_pct}}% of the memory limit used" },
    { id: "rejected", expr: "rejected > 0", severity: "warning", for: 60, text: "Refusing connections ({{rejected}} per second)" },
    { id: "wrong_role", expr: "inputs.expect_role != 'either' && role != inputs.expect_role", severity: "warning", for: 120, text: "This server is {{role}}" },
  ],
  display: {
    cards: ["role", "clients", "used_mb", "ops", "save_status"],
    charts: [
      { title: "Clients", metrics: ["clients", "blocked"] },
      { title: "Memory", metrics: ["used_mb"] },
      { title: "Operations", metrics: ["ops", "evicted"] },
    ],
  },
};

const nginx: ServiceTemplateBody = {
  name: "nginx",
  description: "Connections (active, reading, writing, waiting), requests per second and dropped connections, from stub_status.",
  needs: "A `location /nginx_status { stub_status; allow <dashboard>; deny all; }`.",
  detect: { units: ["nginx"], ports: [80] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(80),
    { key: "path", label: "Status address", type: "string", default: "/nginx_status" },
    verify,
  ],
  collect: {
    status: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{port}}{{path}}",
      verifyTls: "{{verify_tls}}",
      parse: {
        type: "regex",
        pattern:
          "Active connections:\\s*(?<active>\\d+)\\s+server accepts handled requests\\s+(?<accepts>\\d+)\\s+(?<handled>\\d+)\\s+(?<requests>\\d+)\\s+Reading:\\s*(?<reading>\\d+)\\s+Writing:\\s*(?<writing>\\d+)\\s+Waiting:\\s*(?<waiting>\\d+)",
      },
    },
  },
  metrics: {
    active: { label: "Active connections", from: "status", field: "active", agg: "first" },
    reading: { label: "Reading", from: "status", field: "reading", agg: "first" },
    writing: { label: "Writing", from: "status", field: "writing", agg: "first" },
    waiting: { label: "Waiting (keep-alive)", from: "status", field: "waiting", agg: "first" },
    requests: { label: "Requests per second", from: "status", field: "requests", agg: "first", kind: "counter", unit: "/s" },
    // Accepted but never handled: nginx ran out of worker_connections.
    dropped: { label: "Dropped connections per second", from: "status", value: "num(accepts) - num(handled)", agg: "first", kind: "counter", unit: "/s" },
  },
  checks: [{ id: "dropped", expr: "dropped > 0", severity: "warning", for: 60, text: "Dropping connections ({{dropped}} per second): raise worker_connections" }],
  display: {
    cards: ["active", "requests", "writing", "waiting"],
    charts: [
      { title: "Connections", metrics: ["active", "reading", "writing", "waiting"] },
      { title: "Requests per second", metrics: ["requests"] },
    ],
  },
};

const rabbitmq: ServiceTemplateBody = {
  name: "RabbitMQ",
  description: "Messages waiting and unacknowledged, connections and consumers, nodes running and their memory and disk alarms, the fullest queues.",
  needs: "The management plugin (port 15672) and a user with the `monitoring` tag.",
  detect: { units: ["rabbitmq-server", "rabbitmq"], ports: [15672] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(15672),
    { key: "user", label: "User (tag: monitoring)", type: "string", required: true },
    { key: "password", label: "Password", type: "secret", required: true },
    { key: "max_ready", label: "Alert when one queue has more waiting than", type: "number", default: 1000 },
    verify,
  ],
  collect: {
    overview: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/api/overview", auth: { user: "{{user}}", password: "{{password}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json" } },
    nodes: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/api/nodes", auth: { user: "{{user}}", password: "{{password}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json" } },
    queues: {
      transport: "http",
      url: "{{scheme}}://{{host}}:{{port}}/api/queues?columns=name,vhost,messages,messages_ready,messages_unacknowledged,consumers,state",
      auth: { user: "{{user}}", password: "{{password}}" },
      verifyTls: "{{verify_tls}}",
      parse: { type: "json" },
    },
  },
  metrics: {
    version: { label: "Version", from: "overview", field: "rabbitmq_version", kind: "state" },
    messages: { label: "Messages", from: "overview", field: "queue_totals.messages" },
    ready: { label: "Waiting", from: "overview", field: "queue_totals.messages_ready" },
    unacked: { label: "Unacknowledged", from: "overview", field: "queue_totals.messages_unacknowledged" },
    connections: { label: "Connections", from: "overview", field: "object_totals.connections" },
    consumers: { label: "Consumers", from: "overview", field: "object_totals.consumers" },
    queues: { label: "Queues", from: "overview", field: "object_totals.queues" },
    nodes: { label: "Nodes", from: "nodes", agg: "count" },
    nodes_down: { label: "Nodes not running", from: "nodes", where: "running != true", agg: "count" },
    alarms: { label: "Nodes with an alarm", from: "nodes", where: "mem_alarm == true || disk_free_alarm == true", agg: "count" },
    memory_pct: { label: "Fullest node memory", from: "nodes", value: "mem_used / mem_limit * 100", agg: "max", unit: "%" },
    fullest_ready: { label: "Most waiting in one queue", from: "queues", field: "messages_ready", agg: "max" },
  },
  members: {
    label: "Queues",
    from: "queues",
    key: "name",
    ok: "state == 'running' && messages_ready <= inputs.max_ready",
    columns: { vhost: "vhost", waiting: "messages_ready", unacknowledged: "messages_unacknowledged", consumers: "consumers", state: "state" },
  },
  checks: [
    { id: "node_down", expr: "nodes_down > 0", severity: "critical", for: 60, text: "{{nodes_down}} node(s) not running" },
    { id: "alarm", expr: "alarms > 0", severity: "critical", for: 0, text: "A memory or disk alarm is blocking publishers on {{alarms}} node(s)" },
    { id: "backlog", expr: "fullest_ready > inputs.max_ready", severity: "warning", for: 600, text: "A queue has {{fullest_ready}} messages waiting" },
  ],
  display: {
    cards: ["ready", "unacked", "consumers", "nodes", "alarms"],
    charts: [
      { title: "Messages", metrics: ["ready", "unacked"] },
      { title: "Connections and consumers", metrics: ["connections", "consumers"] },
    ],
  },
};

const chrony: ServiceTemplateBody = {
  name: "chrony (time sync)",
  description: "Whether the clock is synchronised, how far off it is, and its stratum, from chronyc tracking.",
  needs: "The host's SSH login; chronyc tracking needs no root.",
  detect: { units: ["chrony", "chronyd"] },
  inputs: [{ key: "max_offset_ms", label: "Alert when the clock is off by more than (ms)", type: "number", default: 100 }],
  collect: { tracking: { transport: "ssh", command: "chronyc -c tracking", parse: { type: "csv", header: false } } },
  metrics: {
    source: { label: "Synchronised to", from: "tracking", field: "c2", kind: "state" },
    stratum: { label: "Stratum", from: "tracking", field: "c3", agg: "first" },
    offset_ms: { label: "Clock offset", from: "tracking", value: "abs(num(c5)) * 1000", agg: "first", unit: "ms" },
    skew_ppm: { label: "Skew", from: "tracking", field: "c10", agg: "first", unit: "ppm" },
    leap: { label: "Leap status", from: "tracking", field: "c14", kind: "state" },
  },
  checks: [
    { id: "unsynchronised", expr: "leap == 'Not synchronised' || stratum >= 16", severity: "critical", for: 300, text: "The clock is not synchronised" },
    { id: "offset", expr: "offset_ms > inputs.max_offset_ms", severity: "warning", for: 300, text: "The clock is {{offset_ms}} ms off" },
  ],
  display: { cards: ["leap", "offset_ms", "stratum", "source"], charts: [{ title: "Clock offset", metrics: ["offset_ms"] }] },
};

const postfix: ServiceTemplateBody = {
  name: "Postfix mail queue",
  description: "Messages in the queue: deferred (delivery failing), active and on hold, from postqueue -j.",
  needs: "The host's SSH login (any user may read the queue unless authorized_mailq_users says otherwise).",
  detect: { units: ["postfix", "postfix@-"] },
  inputs: [{ key: "max_deferred", label: "Alert above this many deferred", type: "number", default: 20 }],
  collect: { queue: { transport: "ssh", command: "postqueue -j", parse: { type: "lines" } } },
  metrics: {
    queued: { label: "Messages queued", from: "queue", where: "startsWith(line, '{')", agg: "count" },
    deferred: { label: "Deferred", from: "queue", where: "contains(line, '\"queue_name\": \"deferred\"')", agg: "count" },
    active: { label: "Being delivered", from: "queue", where: "contains(line, '\"queue_name\": \"active\"')", agg: "count" },
    hold: { label: "On hold", from: "queue", where: "contains(line, '\"queue_name\": \"hold\"')", agg: "count" },
  },
  checks: [{ id: "deferred", expr: "deferred > inputs.max_deferred", severity: "warning", for: 900, text: "{{deferred}} messages deferred (mail is not going out)" }],
  display: { cards: ["queued", "deferred", "hold"], charts: [{ title: "Queue", metrics: ["deferred", "active", "hold"] }] },
};

const mdadm: ServiceTemplateBody = {
  name: "Linux software RAID (mdadm)",
  description: "Every md array: its disks working of the total, and whether it is rebuilding, from /proc/mdstat.",
  needs: "The host's SSH login; /proc/mdstat needs no root.",
  detect: { units: ["mdmonitor", "mdadm"] },
  inputs: [],
  collect: {
    arrays: {
      transport: "ssh",
      command: "cat /proc/mdstat",
      parse: {
        type: "regex",
        pattern:
          "^(?<array>md\\w+) : (?<state>\\w+)(?: \\((?<mode>[^)]+)\\))? (?<level>\\w+)[^\\n]*\\n\\s+\\d+ blocks[^\\n]*?\\[(?<total>\\d+)/(?<working>\\d+)\\] \\[(?<map>[U_]+)\\](?:\\n\\s+\\[[^\\]]*\\]\\s+(?<sync>\\w+)\\s*=\\s*(?<sync_pct>[\\d.]+)%)?",
      },
    },
  },
  metrics: {
    arrays: { label: "Arrays", from: "arrays", agg: "count" },
    degraded: { label: "Degraded", from: "arrays", where: "num(working) < num(total)", agg: "count" },
    syncing: { label: "Rebuilding or checking", from: "arrays", where: "sync != null", agg: "count" },
  },
  members: {
    label: "Arrays",
    from: "arrays",
    key: "array",
    ok: "num(working) == num(total)",
    columns: { level: "level", "disks working": "working", disks: "total", map: "map", rebuilding: "sync != null ? sync + ' ' + sync_pct + '%' : ''" },
  },
  checks: [{ id: "degraded", expr: "degraded > 0", severity: "critical", for: 60, text: "{{degraded}} array(s) degraded: a disk has failed or is missing" }],
  display: { cards: ["arrays", "degraded", "syncing"] },
};

const zfs: ServiceTemplateBody = {
  name: "ZFS pools",
  description: "Every pool's health and how full it is, from zpool list.",
  needs: "The host's SSH login; zpool list needs no root on most systems.",
  detect: { units: ["zfs-zed", "zfs.target", "zfs-import-cache"] },
  inputs: [{ key: "max_full_pct", label: "Alert when a pool is fuller than (%)", type: "number", default: 80 }],
  collect: {
    pools: { transport: "ssh", command: "zpool list -H -p -o name,size,alloc,free,frag,cap,health", parse: { type: "csv", delimiter: "\t", header: false } },
  },
  metrics: {
    pools: { label: "Pools", from: "pools", agg: "count" },
    unhealthy: { label: "Not ONLINE", from: "pools", where: "c7 != 'ONLINE'", agg: "count" },
    fullest_pct: { label: "Fullest pool", from: "pools", field: "c6", agg: "max", unit: "%" },
  },
  members: {
    label: "Pools",
    from: "pools",
    key: "c1",
    ok: "c7 == 'ONLINE' && num(c6) <= inputs.max_full_pct",
    columns: { health: "c7", "used %": "c6", "size GB": "round(num(c2) / 1073741824, 1)", "free GB": "round(num(c4) / 1073741824, 1)", "fragmented %": "c5" },
  },
  checks: [
    { id: "unhealthy", expr: "unhealthy > 0", severity: "critical", for: 0, text: "{{unhealthy}} pool(s) not ONLINE" },
    { id: "full", expr: "fullest_pct > inputs.max_full_pct", severity: "warning", for: 600, text: "A pool is {{fullest_pct}}% full" },
  ],
  display: { cards: ["pools", "unhealthy", "fullest_pct"], charts: [{ title: "Fullest pool", metrics: ["fullest_pct"] }] },
};

const systemdFailed: ServiceTemplateBody = {
  name: "systemd failed units",
  description: "Any unit on the host that has failed (a crashed service, a timer's job that went wrong).",
  needs: "The host's SSH login; nothing needs root.",
  inputs: [{ key: "ignore", label: "Ignore units whose name contains (optional)", type: "string", default: "" }],
  collect: { failed: { transport: "ssh", command: "systemctl list-units --failed --plain --no-legend --no-pager", parse: { type: "lines" } } },
  metrics: {
    failed: { label: "Failed units", from: "failed", where: "inputs.ignore == '' || !contains(f1, inputs.ignore)", agg: "count" },
  },
  members: { label: "Failed units", from: "failed", where: "inputs.ignore == '' || !contains(f1, inputs.ignore)", key: "f1", ok: "false", columns: { load: "f2", active: "f3", sub: "f4" } },
  checks: [{ id: "failed", expr: "failed > 0", severity: "warning", for: 60, text: "{{failed}} unit(s) failed" }],
  display: { cards: ["failed"] },
};

const garage: ServiceTemplateBody = {
  name: "Garage (S3 store)",
  description: "Cluster health, nodes connected, partitions with quorum, block resync errors and free disk, from Garage's /metrics.",
  needs: "The admin port (3903) and the metrics_token (or admin_token) from garage.toml.",
  detect: { units: ["garage"], ports: [3903] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(3903),
    { key: "token", label: "Metrics token", type: "secret" },
    { key: "min_free_pct", label: "Alert when free data disk is below (%)", type: "number", default: 10 },
    verify,
  ],
  collect: {
    metrics: {
      transport: "prometheus",
      url: "{{scheme}}://{{host}}:{{port}}/metrics",
      headers: { authorization: "Bearer {{token}}" },
      verifyTls: "{{verify_tls}}",
      keep: ["cluster_", "garage_", "block_resync_errored_blocks", "block_resync_queue_length", "api_s3_error_counter", "api_s3_request_counter"],
    },
  },
  metrics: {
    version: { label: "Version", from: "metrics", where: "__name__ == 'garage_build_info'", field: "version", kind: "state" },
    healthy: { label: "Healthy", from: "metrics", where: "__name__ == 'cluster_healthy'", field: "value", agg: "first" },
    available: { label: "Available", from: "metrics", where: "__name__ == 'cluster_available'", field: "value", agg: "first" },
    nodes_connected: { label: "Nodes connected", from: "metrics", where: "__name__ == 'cluster_connected_nodes'", field: "value", agg: "first" },
    nodes_known: { label: "Nodes known", from: "metrics", where: "__name__ == 'cluster_known_nodes'", field: "value", agg: "first" },
    storage_ok: { label: "Storage nodes up", from: "metrics", where: "__name__ == 'cluster_storage_nodes_ok'", field: "value", agg: "first" },
    storage_total: { label: "Storage nodes", from: "metrics", where: "__name__ == 'cluster_storage_nodes'", field: "value", agg: "first" },
    partitions: { label: "Partitions", from: "metrics", where: "__name__ == 'cluster_partitions'", field: "value", agg: "first" },
    partitions_quorum: { label: "Partitions with quorum", from: "metrics", where: "__name__ == 'cluster_partitions_quorum'", field: "value", agg: "first" },
    resync_errors: { label: "Blocks failing to resync", from: "metrics", where: "__name__ == 'block_resync_errored_blocks'", field: "value", agg: "first" },
    resync_queue: { label: "Blocks waiting to resync", from: "metrics", where: "__name__ == 'block_resync_queue_length'", field: "value", agg: "first" },
    data_free: { from: "metrics", where: "__name__ == 'garage_local_disk_avail' && volume == 'data'", field: "value", agg: "first" },
    data_total: { from: "metrics", where: "__name__ == 'garage_local_disk_total' && volume == 'data'", field: "value", agg: "first" },
    free_pct: { label: "Data disk free", expr: "data_total > 0 ? data_free / data_total * 100 : null", unit: "%" },
    requests: { label: "S3 requests per second", from: "metrics", where: "__name__ == 'api_s3_request_counter'", field: "value", agg: "sum", kind: "counter", unit: "/s" },
    errors_5xx: { label: "S3 server errors per second", from: "metrics", where: "__name__ == 'api_s3_error_counter' && startsWith(status_code, '5')", field: "value", agg: "sum", kind: "counter", unit: "/s" },
  },
  checks: [
    { id: "unavailable", expr: "available == 0", severity: "critical", for: 60, text: "The cluster cannot serve requests (no quorum)" },
    { id: "unhealthy", expr: "available == 1 && healthy == 0", severity: "warning", for: 300, text: "{{storage_ok}} of {{storage_total}} storage nodes up" },
    { id: "resync", expr: "resync_errors > 0", severity: "warning", for: 600, text: "{{resync_errors}} block(s) failing to resync" },
    { id: "disk", expr: "free_pct < inputs.min_free_pct", severity: "warning", for: 600, text: "Only {{free_pct}}% of the data disk free" },
  ],
  display: {
    cards: ["healthy", "storage_ok", "partitions_quorum", "free_pct", "resync_errors"],
    charts: [
      { title: "S3 requests", metrics: ["requests", "errors_5xx"] },
      { title: "Resync queue", metrics: ["resync_queue"] },
    ],
  },
};

const meilisearch: ServiceTemplateBody = {
  name: "Meilisearch",
  description: "Health, documents per index, whether it is indexing, tasks waiting and failed, and the database size.",
  needs: "A key that may read stats and tasks (the master key, or an API key with stats.get and tasks.get).",
  detect: { units: ["meilisearch"], ports: [7700] },
  inputs: [
    { key: "scheme", label: "Scheme", type: "select", options: ["http", "https"], default: "http" },
    port(7700),
    { key: "key", label: "API key", type: "secret" },
    { key: "max_waiting", label: "Alert above this many tasks waiting", type: "number", default: 1000 },
    verify,
  ],
  collect: {
    health: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/health", verifyTls: "{{verify_tls}}", parse: { type: "json" } },
    stats: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/stats", headers: { authorization: "Bearer {{key}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json" } },
    indexes: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/stats", headers: { authorization: "Bearer {{key}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json", rows: "indexes.*" } },
    waiting: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/tasks?statuses=enqueued,processing&limit=1", headers: { authorization: "Bearer {{key}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json" } },
    failed: { transport: "http", url: "{{scheme}}://{{host}}:{{port}}/tasks?statuses=failed&limit=1", headers: { authorization: "Bearer {{key}}" }, verifyTls: "{{verify_tls}}", parse: { type: "json" }, optional: true },
  },
  metrics: {
    status: { label: "Health", from: "health", field: "status", kind: "state" },
    db_mb: { label: "Database size", from: "stats", value: "databaseSize / 1048576", agg: "first", unit: "MB" },
    indexes: { label: "Indexes", from: "indexes", agg: "count" },
    documents: { label: "Documents", from: "indexes", field: "numberOfDocuments", agg: "sum" },
    indexing: { label: "Indexes being updated", from: "indexes", where: "isIndexing == true", agg: "count" },
    waiting: { label: "Tasks waiting", from: "waiting", field: "total", agg: "first" },
    failed: { label: "Tasks failed per second", from: "failed", field: "total", agg: "first", kind: "counter", unit: "/s" },
  },
  members: { label: "Indexes", from: "indexes", key: "_key", ok: "true", columns: { documents: "numberOfDocuments", indexing: "isIndexing ? 'yes' : 'no'" } },
  checks: [
    { id: "unhealthy", expr: "status != 'available'", severity: "critical", for: 60, text: "Meilisearch says {{status}}" },
    { id: "backlog", expr: "waiting > inputs.max_waiting", severity: "warning", for: 600, text: "{{waiting}} tasks waiting" },
  ],
  display: {
    cards: ["status", "documents", "waiting", "db_mb"],
    charts: [
      { title: "Tasks waiting", metrics: ["waiting"] },
      { title: "Documents", metrics: ["documents"] },
    ],
  },
};

export const BUILTIN_TEMPLATES: Record<string, ServiceTemplateBody> = {
  haproxy,
  keepalived,
  postgresql: postgres,
  mysql,
  cockroachdb: cockroach,
  yugabytedb: yugabyte,
  apache,
  kea,
  technitium,
  redis,
  nginx,
  rabbitmq,
  chrony,
  postfix,
  mdadm,
  zfs,
  "systemd-failed": systemdFailed,
  garage,
  meilisearch,
  "prometheus-metric": genericPrometheus,
  "json-value": genericJson,
  "systemd-unit": genericSystemd,
  "sql-number": genericSql,
};

/** Which built-ins a discovery result suggests: a unit whose name starts with a detect unit. */
export function suggestTemplates(
  templates: Array<{ key: string; body: Pick<ServiceTemplateBody, "detect"> }>,
  units: Array<{ name: string; active: boolean }>,
): Array<{ key: string; unit: string }> {
  const out: Array<{ key: string; unit: string }> = [];
  for (const t of templates) {
    const wanted = t.body.detect?.units ?? [];
    const hit = units.find((u) => wanted.some((w) => u.name === w || u.name.startsWith(`${w}@`) || u.name.startsWith(`${w}-`)));
    if (hit) out.push({ key: t.key, unit: hit.name });
  }
  return out;
}
