Output the built-in service templates are tested against (`apps/api/test/service-monitoring.test.ts`).

Captured from the real software (2026-10-25, throwaway containers):

- `cockroach-status-vars.txt`: CockroachDB v24 `/_status/vars` (the dev stack's node).
- `yugabyte-tserver-metrics.txt`, `yugabyte-master-health.json`, `yugabyte-master-tablet-servers.json`: YugabyteDB 2024.2 (one node).
- `haproxy-stats.csv`: HAProxy 3 `/stats;csv` with backends `app` (one server up, one down) and `dead` (all down).
- `apache-server-status.txt`: Apache httpd 2.4 `/server-status?auto` (first line, the host name, replaced with `localhost`).

Written from the vendor's documentation (no server was run):

- `kea-stat-lease4-get.json`: the shape of `stat-lease4-get` from the Kea ARM (stat_cmds hook), numbers made up.
- `technitium-dashboard-stats.json`: the shape of `/api/dashboard/stats/get` from Technitium's API docs, numbers made up.
