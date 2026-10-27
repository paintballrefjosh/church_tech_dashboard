Output the built-in service templates are tested against (`apps/api/test/service-monitoring.test.ts`).

Captured from the real software (2026-10-25, throwaway containers):

- `cockroach-status-vars.txt`: CockroachDB v24 `/_status/vars` (the dev stack's node).
- `yugabyte-tserver-metrics.txt`, `yugabyte-master-health.json`, `yugabyte-master-tablet-servers.json`: YugabyteDB 2024.2 (one node).
- `haproxy-stats.csv`: HAProxy 3 `/stats;csv` with backends `app` (one server up, one down) and `dead` (all down).
- `apache-server-status.txt`: Apache httpd 2.4 `/server-status?auto` (first line, the host name, replaced with `localhost`).

Captured for wave two (2026-10-26, throwaway containers unless said otherwise):

- `valkey-auth-info.txt`, `valkey-replica-info.txt`, `valkey-noauth.txt`: Valkey 8.0.1 answering `AUTH` (RESP) + `INFO` on a master with
  `requirepass`, on its replica (link up), and `INFO` without the password (`-NOAUTH`). Raw bytes as the tcp transport receives them.
- `nginx-stub-status.txt`: nginx 1.27 `stub_status`.
- `rabbitmq-overview.json`, `rabbitmq-queues.json`: RabbitMQ 4.0.9 management API (`/api/overview`, `/api/queues?columns=...`) with
  two queues, five messages waiting in one. `rabbitmq-nodes.json` is `/api/nodes` cut down to the fields the template reads (the
  full answer is about 30 KB of Erlang runtime detail).
- `chronyc-tracking.csv`: chrony 4 `chronyc -c tracking` (Alpine, synchronised to pool.ntp.org).
- `postfix-postqueue.jsonl`: Postfix 3.9 `postqueue -j` with three messages deferred (relay host unreachable).
- `systemctl-failed.txt`: `systemctl list-units --failed --plain --no-legend` on the dev host, with a throwaway user unit that failed.
- `garage-metrics.txt`: Garage v2.1.0 `/metrics` from the dev stack's store, cut down to the families the template keeps.
- `meilisearch-*.json`: Meilisearch 1.10.3 `/health`, `/stats` and `/tasks` from the dev stack.

Written from the vendor's documentation (no server was run):

- `mdstat.txt`: `/proc/mdstat` with a RAID 5 missing a disk and recovering, and a healthy RAID 1, in the format of the kernel's md
  documentation (no array could be built here without touching the host's kernel).
- `zpool-list.tsv`: `zpool list -H -p -o name,size,alloc,free,frag,cap,health` (tab-separated, exact numbers) per the zpool-list
  manual, one pool ONLINE and one DEGRADED (no ZFS on the dev host).

- `kea-stat-lease4-get.json`: the shape of `stat-lease4-get` from the Kea ARM (stat_cmds hook), numbers made up.
- `technitium-dashboard-stats.json`: the shape of `/api/dashboard/stats/get` from Technitium's API docs, numbers made up.
