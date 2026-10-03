# Infrastructure monitoring

Agentless resource monitoring for Linux hosts, Docker hosts, and Proxmox VE,
surfaced under **IT → Infrastructure** (`/monitoring/infra`). Nothing is
installed on the targets — the API's in-process `InfraCollector` polls each
target over SSH or the Proxmox REST API and stores a time-series of metrics.

Access is the existing **`monitoring`** module: any tier can view; the `admin`
tier (i.e. `monitors:write:any`) can add/edit/delete targets and edit the
collector settings at `/admin/settings/monitoring`.

## Target kinds

| Kind | Transport | What it collects |
|---|---|---|
| **Linux host** | SSH (`/proc`, `df`) | CPU (total + per-core + load), memory, per-filesystem disk, disk IO, per-interface network, uptime, processes, temperature |
| **Docker host** | `docker` CLI over SSH | per-container state/health/CPU/mem, grouped by compose project; running/stopped/unhealthy counts |
| **Proxmox VE** | REST API + token | per-node CPU/mem/disk/load/uptime, cluster quorum, per-guest (VM/CT) status/CPU/mem, storage-pool usage |

Credentials are encrypted at rest (AES-256-GCM, keyed from `AUTH_SECRET`) and are
never returned by the API. On an edit, leave the secret blank to keep it
unchanged. Use the **Test connection** button on the form to verify before
saving.

## Host preparation

### Linux host (and Docker host) — SSH

Create a dedicated, least-privilege user and authorise a key:

```bash
sudo useradd -m -s /bin/bash monitor
sudo -u monitor mkdir -p /home/monitor/.ssh
# paste the collector's public key:
sudo -u monitor tee -a /home/monitor/.ssh/authorized_keys < id_ed25519.pub
```

- **Linux metrics** need no special privileges — reading `/proc`, `df`,
  `/proc/net/dev`, `/proc/diskstats` works as any user.
- **Docker** requires the user to reach the daemon. Add them to the `docker`
  group: `sudo usermod -aG docker monitor`. Note this is effectively root on the
  host; if that's unacceptable, front the socket with a read-only
  docker-socket-proxy and point a separate mechanism at it.
- Host-key handling is trust-on-first-use: the fingerprint seen on the first
  successful poll is pinned; a later mismatch is rejected (the target goes
  `down` with a host-key error) rather than silently trusted.

In the form, choose **SSH key** (paste the private key, optional passphrase) or
**SSH password**, set the SSH **username**, and the **port** (default 22).

### Proxmox VE — API token

Create an API token with a read-only role:

1. Datacenter → Permissions → API Tokens → Add. Pick a user (e.g.
   `monitor@pve`) and a token id (e.g. `dashboard`). Copy the secret shown once.
2. Give the token (or its user) the **`PVEAuditor`** role at path `/`.

In the form, choose **Proxmox API token**, set **Token ID** to
`user@realm!tokenid` (e.g. `monitor@pve!dashboard`), paste the **Token secret**,
and the **port** (default 8006). Homelab PVE presents a self-signed cert, so
**Allow self-signed TLS** is on by default; paste a **CA certificate** to pin it
instead.

## Alerts

Each target can carry threshold rules (metric, operator, value, sustained
seconds). When a rule breaches for its window, an incident opens (shared with
the up/down monitor incident feed), and everyone with monitoring read access
gets an in-app + email notification; recovery resolves it. v1 evaluates
target-level scalars (`cpuPct`, `memPct`, `diskPctMax`) and dotted metric paths
(e.g. `load.one`).

## Retention

Raw samples are kept 7 days (CockroachDB row-level TTL). The collector rolls raw
data into 5-minute (kept 90 days) and 1-hour (kept 1 year) min/avg/max buckets;
the metrics API serves raw for short ranges and rollups for longer ones.

## Collector tuning

`/admin/settings/monitoring`:

- **Collector tick interval (seconds)** — scheduler granularity (default 15).
  Targets still poll at their own configured interval.
- **Poll concurrency** — max targets polled at once (default 6); raise for
  larger fleets.

Changes take effect on the next API restart. Env fallbacks: `INFRA_TICK_SEC`,
`INFRA_CONCURRENCY`, `INFRA_ROLLUP_MS`.
