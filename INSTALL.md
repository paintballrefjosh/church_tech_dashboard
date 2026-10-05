# Install & operate

## Prerequisites

- **Docker** 25+ with the Compose plugin v2.20 or newer (`docker compose version`)
- **git** and **make**
- A free **host port 8100** (configurable via `EXTERNAL_PORT` in `.env`)
- Optionally, a Google and/or Microsoft (Entra) OAuth app for single sign-on — you can
  also run with local accounts only and add OAuth later. It's all configured in the
  browser at `/admin/settings`, not in files.

Want the shortest path instead? See [QUICKSTART.md](./QUICKSTART.md).

You do **not** need Node.js or pnpm on the host. Every dev/admin command has a
docker-only equivalent — see [the dockerized commands section](#dockerized-commands-no-node-on-host).

## Quick start (dev)

```bash
git clone https://github.com/paintballrefjosh/church_tech_dashboard church-dashboard
cd church-dashboard
make up                        # auto-generates .env, creates ./data/ bind mounts, starts stack
make migrate                   # applies SQL migrations to the database
make seed                      # seeds default groups + per-module access and the bootstrap admin
make logs                      # tail everything
```

Then open <http://localhost:8100> and sign in with:

| Username | Password |
|---|---|
| `admin` | `admin` |

You will be required to set a new password on first login. After that, runtime configuration
(Google OAuth, SMTP, site name, etc.) lives in the database — edit it at `/admin/settings`,
no file editing needed.

If you ever need the default back (lost password, fresh start): `make reset-admin`. This is
an **explicit** opt-in — `make regression` and the automated tests never touch the admin
user. They use a dedicated `regression-test@local` user that's reset by
`make reset-test-user` (run automatically as the first step of `make regression`).

The dev stack includes:
- Single-node CockroachDB on internal `:26257`, unless you use an external database (see below). Its admin UI runs in insecure mode with no login, so it's published on the host's loopback only, at <http://localhost:8180> (`COCKROACH_UI_PORT`). From another machine, tunnel to it: `ssh -L 8180:localhost:8180 <server>`, then open <http://localhost:8180>. Its logs go to `./data/cockroach-logs`; if `./data` is on NFS, set `COCKROACH_LOG_DIR` to a local-disk path, because an NFS write stall makes Cockroach kill itself.
- Email: no bundled mail sink — configure a real SMTP server in `/admin/settings` (leave `smtp.host` blank to disable email). For local testing, point it at a throwaway SMTP catcher of your choice or your real mail server.
- Garage (S3-compatible object store) on internal `:3900`, with no host port. A one-shot `garage-init` creates its layout, access key and bucket. See [Choosing the object store](#choosing-the-object-store)
- Meilisearch on internal `:7700` (throwaway dev master key, no host port)
- A `monitor` probe worker running the uptime checks

## Choosing a database

The app talks to its database over the PostgreSQL wire protocol and runs on
**CockroachDB** or **YugabyteDB (YSQL)**. Pick one of three setups with `DB_MODE` in `.env`:

| Setup | `.env` | Notes |
|---|---|---|
| Bundled CockroachDB (default) | `DB_MODE=bundled` | Runs inside the stack: one node in dev, three in prod. Nothing else to set. |
| External YugabyteDB | `DB_MODE=external`<br>`DATABASE_URL=postgresql://user:pass@yb-host:5433/church` | YSQL listens on port 5433. Tested on 2024.2 LTS and 2026.1. |
| External CockroachDB | `DB_MODE=external`<br>`DATABASE_URL=postgresql://user:pass@crdb-host:26257/church?sslmode=verify-full` | Your own cluster, licensed as you see fit. |

You never say which engine an external database is: the app detects it from
`SELECT version()` and adapts. The engine and version show on the Monitoring page's
service health. For an external database:

- **Create the database first** (`CREATE DATABASE church;`). Migrations create the
  tables but not the database.
- **The containers must be able to reach it.** `localhost` inside a container is the
  container itself, so use a hostname or IP that resolves from the Docker network.
- **YugabyteDB 2024.2 (PG 11 based)** needs the `pgcrypto` extension for
  `gen_random_uuid()`. `make migrate` enables it if the user is allowed to; otherwise
  have the DBA run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` once. Newer YugabyteDB
  releases have it built in.
- **TLS.** Put the options in the URL:
  `postgresql://user:pass@db.example.org:26257/church?sslmode=verify-full&sslrootcert=/certs/ca.crt`
  (`sslcert` and `sslkey` for client certificates). Mount the certificate files into the
  `api`, `web` and `monitor` containers. Use `sslmode=verify-full` and name the server by
  **host name**, not IP address, so the certificate can be matched to it: this driver treats
  `require` and `verify-ca` as `verify-full` too, and a server certificate that does not name
  the host you connected to is refused. `sslmode=disable` is for a database on a trusted
  network only.
- **What the app does when a database node fails.** Every process opens its connections
  through one shared factory: a broken idle connection is replaced rather than crashing the
  process, connections are named (`church-api`, `church-web`, `church-monitor`) so you can
  see them in the database's session list, they are recycled every 30 minutes so they move to
  live nodes after a failover, and statements that are safe to repeat are retried
  automatically (anything that never reached the database or was rolled back, and plain reads
  whose connection broke). A write whose outcome is unknown is **never** retried: it fails
  and the user retries it. In a test that killed one node of a three-node CockroachDB behind
  a load balancer under load, nothing was lost or duplicated and almost nothing failed; with
  the whole database down, requests failed for as long as it was down and the app recovered
  about six seconds after it came back, without a restart.
- **Backups are yours.** `make db-backup` only covers the bundled database; use
  `ysql_dump` or `cockroach BACKUP` for an external one.

`scripts/compose.sh` reads `DB_MODE` and `DATABASE_URL`, switches the bundled database
(the `bundled-db` compose profile) on or off, and runs `docker compose`. Every `make`
target goes through it. If you run compose by hand, use the script
(`scripts/compose.sh ps`, `scripts/compose.sh --prod up -d`), or export `DATABASE_URL`
yourself and add `--profile bundled-db` for the bundled database.

Switching an existing install between databases moves no data. Export from the old one
and import into the new one with that engine's tools before changing `DB_MODE`.

## Choosing the object store

Uploaded files (wiki attachments, note images, ticket attachments) live in an S3-compatible
store. Pick one of two setups with `S3_MODE` in `.env`, the same way as `DB_MODE`:

| Setup | `.env` | Notes |
|---|---|---|
| Bundled Garage (default) | `S3_MODE=bundled` | Runs inside the stack. Nothing to configure: its access key and internal secret are derived from `AUTH_SECRET`. |
| External S3-compatible store | `S3_MODE=external`<br>`S3_ENDPOINT=https://s3.example.org`<br>`S3_ACCESS_KEY=...`<br>`S3_SECRET_KEY=...`<br>`S3_BUCKET=church-files` | AWS S3, Backblaze B2, your own MinIO or Garage. The bundled MinIO is not started. |

**About the bundled Garage:**

- It is [Garage](https://garagehq.deuxfleurs.fr), a small S3-compatible store built for self-hosting,
  one node here (a cluster of them in a multi-node setup). It replaced MinIO, whose images are no longer
  published to Docker Hub or quay.io, so a new host could not have pulled them.
- **Its access key is derived from `AUTH_SECRET`** (a Garage key must be `GK` plus 24 hex characters, so it
  cannot be chosen freely). Changing `AUTH_SECRET` therefore also changes the store's key: the next start
  imports the new one, and uploads keep working. You can set `S3_ACCESS_KEY` / `S3_SECRET_KEY` yourself,
  but only in Garage's format; `scripts/compose.sh` refuses anything else.
- **Its metadata database must be on local disk, not NFS or SMB.** It is an LMDB database; on a network
  filesystem it can be silently corrupted. The container refuses to start if `GARAGE_META_DIR` (default
  `./data/garage/meta`) is on one. If `./data` is a network share, set `GARAGE_META_DIR` in `.env` to a local
  folder (like `COCKROACH_LOG_DIR`). The data blocks (`./data/garage/data`) may be on the share.
- Nothing is published on the host: the S3 API (`garage:3900`) is only on the stack's network.

**Moving from MinIO to Garage** (an install made before this change keeps its files in `./data/minio`):

```bash
scripts/compose.sh build garage
scripts/compose.sh up -d garage garage-init      # starts Garage next to the old MinIO, which keeps running
scripts/s3-copy.sh --from-minio --to-bundled     # the bulk of it, while users keep working
scripts/compose.sh stop api web                  # no more uploads
scripts/s3-copy.sh --from-minio --to-bundled     # the last few files; verifies every copied object by SHA-256
scripts/compose.sh up -d api web                 # the app now uses Garage
```

Check the files open in the app, then `docker stop` the old `church-minio-1` container (`docker rm` it when
you are sure). `./data/minio` is left alone: delete it when you no longer need the rollback. The old
MinIO images can no longer be pulled, so on a host that does not already have them there is no way to read
`./data/minio` again; keep a copy of the images (`docker save minio/minio:latest minio/mc:latest`) if you
want that rollback. `scripts/compose.sh up` warns if it finds `./data/minio` with files in it and an empty Garage.

For an external store:

- **Create the bucket first.** The app tries to create it on the first upload, but that needs
  permission most access keys do not have. `Monitoring` shows the storage as *degraded* with a
  message until the bucket exists.
- **`S3_ENDPOINT`** is `host[:port]` or a URL with no path. `https://` turns TLS on (or set
  `S3_USE_SSL=true`); a contradiction between the two is refused at start. A store with a
  private CA needs the CA given to the containers (`NODE_EXTRA_CA_CERTS`).
- **`S3_PATH_STYLE`** defaults to `true` (`host/bucket/key`), which MinIO, Garage and most
  self-hosted stores need. Set it to `false` for virtual-hosted addressing (`bucket.host/key`),
  which is what AWS S3 prefers. Only path-style has been tested here, against Garage and MinIO.
- **`S3_REGION`** (default `us-east-1`) and **`S3_SESSION_TOKEN`** (temporary credentials) are
  there if the store needs them.
- The old names (`MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_REGION`, `MINIO_USE_SSL`, and
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` as the keys) are still read when the `S3_*` one is not
  set, so an existing `.env` needs no change. Keys may contain `/`, `+` and `=`.
- Uploads are stored under `attachments/` and database backups (below) under `db-backups/`.

**Moving an existing install onto an external store** (`scripts/s3-copy.sh`, which copies and
then proves the copy by hashing every object it copied at both ends; it never deletes anything
and is safe to run repeatedly):

```bash
# 1. The bulk of it, while users keep working:
scripts/s3-copy.sh --to-endpoint https://s3.example.org \
    --to-access-key AKIA... --to-secret-key ... --to-bucket church-files
# 2. Stop uploads, then the final pass (copies the last few files and verifies):
scripts/compose.sh stop api web
scripts/s3-copy.sh ...same flags...
# 3. Put S3_MODE=external and the S3_* lines in .env, then:
scripts/compose.sh up -d
```

`--dry-run` shows what would be copied, and `--from-endpoint ... --from-access-key ...
--from-secret-key ...` copies between any two stores. The same script moves files into a
Garage cluster later.

## Deployment shapes: single node and multi node

There are four supported shapes. You choose one with configuration; the app is the same.

| | Bundled database | Remote database |
|---|---|---|
| **Single node** | **A.** One host runs everything, including CockroachDB | **B.** One host runs the app; you run the database |
| **Multi node** (2 or more) | **C.** Every node runs the full stack including a local CockroachDB; the databases form one cluster | **D.** Every node runs the app; you run the database cluster |

> **Status.** Shapes **A and B** are the long-standing single node installs. **Shape C**
> (bundled database on every node) is implemented and has been exercised on a simulated
> three node cluster, including a node being killed, a loss of the database majority, a
> rolling upgrade and replacing a node that lost its disks (`tests/cluster/`). **Shape D**
> (remote database on every node) is implemented but has not yet been proven end to end:
> treat it as unverified until [docs/multi-node.md](docs/multi-node.md) says otherwise. The
> design and the work breakdown are in that document.

### Single node (shapes A and B)

Shape A is the default (`DB_MODE=bundled`). Shape B is `DB_MODE=external` with
`DATABASE_URL` pointing at your own CockroachDB or YugabyteDB, as described in
[Choosing a database](#choosing-a-database).

What each survives:

| Shape | Survives | Does not survive |
|---|---|---|
| **A**, dev compose (one Cockroach node) | A container restart | Disk loss, host loss, DB corruption |
| **A**, prod compose (three Cockroach containers) | A Cockroach container dying, or one node's data directory being lost | Host loss, or loss of the disk behind `./data/` (all three share it) |
| **B**, external multi-host database | Loss of any one database host (if the cluster has 3+ hosts and a stable address in front, below) | Loss of the app host: restore it from backup |

The prod compose file's three Cockroach containers are a cluster for process-level
resilience only. They run side by side on one host under one project directory, so treat
the host as a single failure domain.

**Putting a multi-host database behind shape B.** The app's Postgres driver takes a single
host in `DATABASE_URL`; it does not fail over between several. Put a TCP load balancer
(HAProxy, a cloud NLB) or a virtual IP in front of the database nodes and point
`DATABASE_URL` at that. CockroachDB nodes listen on `:26257`, YugabyteDB YSQL on `:5433`.
Without it, pointing at one node leaves that node as a single point of failure even though
the cluster behind it is redundant. Use at least 3 database hosts, and create the database
(and `pgcrypto` on YugabyteDB 2024.2) as described under "Choosing a database". Replication
is not a backup.

#### What is not redundant on a single node

These run as one container on the app host. Losing the host, or the container's data
directory, takes the feature out until you restore it.

| Service | What it holds | If it is lost |
|---|---|---|
| `meilisearch` | Search indexes | Search is unavailable. Nothing is lost: the indexes are derived from the database, and the admin **Reindex** button rebuilds them. |
| `garage` (when `S3_MODE=bundled`) | Uploaded files (wiki attachments, note images) | **Real data loss** if `./data/garage/data/` or the metadata folder (`GARAGE_META_DIR`, default `./data/garage/meta`) is gone. Both are needed for a restore, and the `tar` of `data/` covers them only if the metadata folder is inside it. With `S3_MODE=external` the store is yours to run and back up, and this service is not started. |
| `proxy` (Caddy) | Ingress on `:EXTERNAL_PORT` | The site is down. Stateless. |
| `web` | Next.js UI | The UI is down. Stateless. |
| `api` | REST, WebSocket, and all background work | The API, realtime and every background job are down. |
| `monitor` | Uptime probe worker | Service monitors stop probing, so down services are not detected. |

To recover the app host, bring the same `.env` (especially `AUTH_SECRET`) and the `data/`
backup onto a new machine and run `scripts/compose.sh --prod up -d --build`. With an
external database (shape B) the database itself is already off the host.

#### Adding nodes to a single node install

Do not add a second `api` or `monitor` container by hand (for example
`docker compose up --scale api=2`) or point a second host at the same database as if it were
a single node install: the nodes would not know about each other's certificates, object
store or load balancer. Multi node is its own mode, `DEPLOY_MODE=cluster`, set up as
described under [Multi node](#multi-node-shapes-c-and-d). A single node install keeps
working as it is; it cannot be converted in place, see
[Converting a single node install](#converting-a-single-node-install-to-a-cluster).

### Multi node (shapes C and D)

#### How it works

- **An upstream load balancer that you provide**, outside this project, spreads traffic
  across the nodes. **Any node's web front end and API can serve any read or write.** There
  is no primary node and no session stickiness.
- **Nodes are peers.** Work that must run once at a time (polling, schedulers) is shared
  out between nodes with leases kept in the database. If a node stops, its work moves to
  another node within about 30 seconds.
- **The database is the only shared state the app itself depends on.** There is no Redis:
  realtime updates, cache invalidation, the outgoing mail queue and the sign-in rate limit
  all go through the database, so there is nothing else to cluster.
- **Search is per node.** Each node runs its own Meilisearch (it cannot be clustered), and
  every index is rebuilt from, and kept in step with, the database: a change made on one node
  is applied to the others' indexes within a second or two, and a new node builds its index
  from the database when it starts. The UniFi and DNS entries are read by one node and shared
  through the database, so no other node needs to reach those systems to search them. Search
  is eventually consistent across nodes: something created on one node may be missing from a
  search served by another for a moment. The admin **Reindex** button rebuilds the index on
  every node.
- **Uploaded files live in an S3-compatible store** shared by all nodes: Garage, clustered
  across the nodes, in shape C; your own S3 endpoint in shape D (or shape C if you prefer).
- Realtime updates made on one node reach browsers connected to another within about a
  second.

#### Requirements

- **Load balancer**: terminates HTTPS and forwards HTTP to each node's `:EXTERNAL_PORT`;
  needs **no sticky sessions** but must pass **WebSocket upgrades** (realtime is WebSocket
  only: the pages that use it also refresh on a timer, so a client that cannot open a
  WebSocket still works, just less instantly); passes the
  original `Host`; sets `X-Forwarded-For` and `X-Forwarded-Proto`; health-checks each node at
  `/healthz` (200 with the node's name in an `X-Church-Node` header while the node's API can
  reach its database, 503 when it cannot, and 503 "draining" while the node is drained).
- **`TRUSTED_PROXIES`**: set it in `.env` to a space-separated list of your load balancer's
  CIDRs (`TRUSTED_PROXIES=10.0.0.0/24`). The proxy then reads `X-Forwarded-For` from the right
  and takes the first address that is not one of yours, so audit rows and the rate limits see
  the real client IP and a forged header cannot change it. Left unset, every peer is trusted
  and the first entry wins, which a client can forge: acceptable only if the load balancer
  already overwrites the header.
- **The same build on every node.** Give every node the same `AUTH_SECRET` and the same
  build: the web app's page scripts and Server Actions are named by the build, so a page
  served by one node and a request answered by another must come from the same one. Either
  build once and run that image everywhere (`scripts/release.sh`, which prints the
  `BUILD_ID`/`API_IMAGE`/`WEB_IMAGE`/`MONITOR_IMAGE` lines for each node's `.env`), or build
  **the same clean commit** on each node (the build id comes from the commit, so the builds
  are byte-for-byte alike). A working tree with uncommitted changes gets a build id specific
  to those changes, so two nodes match only if the changes are identical.
- **Time**: NTP on every node. CockroachDB nodes shut themselves down if their clocks drift.
- **Network position**: whichever node holds a lease does the polling, so **every node that
  can run background jobs must reach** UniFi, switches, printers, UPS, DNS and monitored
  hosts. Set `BACKGROUND_JOBS=off` on a node that cannot.
- **Low latency between nodes** (one LAN or a fast link). The database waits for a majority
  of nodes on every write, so a slow link between sites makes the whole app slow.
- **Ports between nodes** (shape C), the only ones besides `EXTERNAL_PORT` that a node
  publishes, on `CLUSTER_BIND_ADDR` (default every interface: set it to the cluster network's
  address if the host has several): `CLUSTER_DB_PORT` (default `26257`, the database) and
  `CLUSTER_S3_RPC_PORT` (default `3901`, the object store). Firewall both to the other nodes
  only. `CLUSTER_S3_API_PORT` is off unless you set it, for moving files in or out.

#### How many nodes

A database cluster needs a majority to keep working, which decides what extra nodes buy:

| Nodes | Database and object store | Meaning |
|---|---|---|
| 2 | **No failover.** Losing either node stops writes | Two front ends for capacity and rolling upgrades, not for availability |
| 2 + a `data` witness | Survives losing one node | The cheapest real HA: a third small host (`NODE_ROLE=data`) that runs only the database and object store |
| 3 or more | Survives losing one node (two with 5+) | Full HA |

The object store's replication factor is fixed when the cluster is created, so decide the
node count before first start.

#### Shape C: bundled database on every node

Every node runs the whole stack, including one CockroachDB and one Garage; the databases form
one cluster and so do the object stores.

**What you need**: 2 or more hosts (3, or 2 plus a [witness](#a-witness-node), for real
failover), the same repository checkout or the same release images on each, Docker, NTP, and
the [ports](#requirements) open between them. The examples use three nodes, `10.0.0.11`,
`.12` and `.13`.

1. **`.env` on every node.** The shared secrets are the same on every node (`AUTH_SECRET`,
   `MEILI_MASTER_KEY`); the cluster settings differ per node:

   ```
   DEPLOY_MODE=cluster
   NODE_ID=node-a                     # node-b, node-c ...
   NODE_ADDR=10.0.0.11                # this node's own address, as the others reach it
   CLUSTER_PEERS=10.0.0.12,10.0.0.13  # the OTHER nodes' addresses
   ```

   Everything else keeps its default (`.env.example` lists the optional settings). The
   database password, the object store's keys and its internal secret are all derived from
   `AUTH_SECRET`, so there is nothing more to generate or copy.

2. **Certificates, once.** The database runs in secure mode: its port is published on the
   host network, so nodes and clients must authenticate. On any one machine (keep that
   machine's `data/cluster-certs/ca.key` safe, and off the nodes), give it every node's
   address:

   ```bash
   scripts/cluster.sh init-certs 10.0.0.11 10.0.0.12 10.0.0.13
   ```

   This writes one bundle per address under `data/cluster-certs/`. Copy each bundle to its
   node (copy the directory `data/cluster-certs/10.0.0.12/`, never `ca.key`) and, on each node,
   install it:

   ```bash
   scripts/cluster.sh install-certs path/to/10.0.0.12
   ```

3. **Start the database and object store on every node.** This does not start the application
   yet (it cannot run on an empty database):

   ```bash
   scripts/cluster.sh start-data
   ```

4. **Initialise the database, once, on one node:**

   ```bash
   scripts/cluster.sh init-db
   ```

   This forms the cluster, creates the `church` database and the application's database user.

5. **Form the object store, once.** Each node has an id; the first node needs the others':

   ```bash
   # on every node except the first: print its id
   scripts/cluster.sh node-id               # -> 5c1f...@10.0.0.12:3901
   # on the first node, once, with those ids:
   scripts/cluster.sh garage-bootstrap 5c1f...@10.0.0.12:3901 9ab2...@10.0.0.13:3901
   ```

   This connects the nodes, spreads the data across all of them (3 copies of every file with
   three or more nodes, 2 with two: the count is fixed from now on), and creates the bucket
   and the application's access key.

6. **Migrate and seed, once, on one node:**

   ```bash
   scripts/cluster.sh migrate
   scripts/cluster.sh seed
   ```

7. **Start the application on every node:**

   ```bash
   scripts/cluster.sh up
   ```

8. Add each node to the load balancer (health check `/healthz`). Sign in as `admin` / `admin`,
   change the password, and configure SMTP and sign-in providers under `/admin/settings`.

`scripts/cluster.sh status` on any node shows its health check, the database members and the
object store nodes as that node sees them.

**What is published, and what is not.** Besides `EXTERNAL_PORT`, each node publishes the
database port (`CLUSTER_DB_PORT`, default 26257) and the object store's RPC port
(`CLUSTER_S3_RPC_PORT`, default 3901) on `CLUSTER_BIND_ADDR`, for the other nodes. Everything
else stays inside the stack: the object store's S3 port and admin port, the database's admin UI
(it listens on the container's loopback), Meilisearch. Each application talks to the database
and object store on its own node. The database verifies certificates (`sslmode=verify-full`)
against your CA and the application signs in with a password; node to node traffic uses mutual
TLS. The object store's RPC is authenticated and encrypted with the secret derived from
`AUTH_SECRET`.

#### Shape D: remote database on every node

1. Provide the database cluster and a stable address in front of it, as for shape B. Create
   the database.
2. Provide an S3-compatible bucket and credentials (`S3_MODE=external`), or run the bundled
   object store as for shape C (then each node also needs `NODE_ADDR` and `CLUSTER_PEERS`, and
   steps 5 of shape C apply).
3. On every node: `.env` with the shared secrets, `DEPLOY_MODE=cluster`, `DB_MODE=external`,
   `DATABASE_URL`, the S3 settings and `NODE_ID`. With an external database and an external
   object store no `CLUSTER_*` settings are needed: nodes find each other through the
   database.
4. Run the migrations and seed once (`make prod-migrate prod-seed`, or
   `scripts/compose.sh --prod run --rm --no-deps api node dist/scripts/migrate.js` and
   `.../seed.js`), start every node (`scripts/compose.sh --prod up -d --build`) and add the
   nodes to the load balancer.

This shape has not been proven end to end yet (see the status note above).

#### Certificates (shape C)

`init-certs` makes a certificate authority (valid 10 years) and, per node, a certificate
valid for 5 years for the node's address, the in-stack name `cockroach`, `localhost` and
`127.0.0.1`, plus a client certificate for the `root` database user that the scripts use. The
application does not use client certificates: it trusts the CA (`ca.crt`) and signs in with a
password. `ca.key` is the only thing that can create more; keep it, and a copy of it, off the
nodes.

**Renewing node certificates** (before they expire, or if one leaks): run `init-certs` again on
the machine that holds the CA, with the same addresses (it keeps the CA and issues new node
certificates), install each new bundle on its node, and tell the database to reload it, which
needs no restart:

```bash
scripts/cluster.sh init-certs 10.0.0.11 10.0.0.12 10.0.0.13
scripts/cluster.sh install-certs path/to/10.0.0.12      # on each node
scripts/compose.sh --prod kill -s HUP cockroach         # on each node: reload, no restart
```

The CA itself is not rotated by these steps; renewing it means issuing a new CA and having
nodes trust both while certificates are swapped (the CockroachDB documentation on certificate
rotation describes the method). Plan that for well before the 10 years are up.

#### Adding a node

The object store's copy count (2 or 3) is fixed, but more nodes spread the same copies thinner
and the database rebalances by itself.

1. On the machine with the CA: `scripts/cluster.sh init-certs <new address>`; install that
   bundle on the new node (`install-certs`).
2. The new node's `.env`: the shared secrets, `DEPLOY_MODE=cluster`, its own `NODE_ID` and
   `NODE_ADDR`, and `CLUSTER_PEERS` naming the existing nodes. Add the new node's address to
   `CLUSTER_PEERS` in the other nodes' `.env` (they read it the next time they start).
3. `scripts/cluster.sh start-data`: its database joins the cluster by itself.
4. Join the object store, giving the id of any existing node (`scripts/cluster.sh node-id` on
   it):

   ```bash
   scripts/cluster.sh garage-join 5c1f...@10.0.0.12:3901
   ```

5. `scripts/cluster.sh up`, then add it to the load balancer.

#### Replacing a node that was lost

A node whose disks are gone, rebuilt as a machine with the same address, `.env` and certificate
bundle but empty data directories:

1. `scripts/cluster.sh start-data` on the new machine. Its database joins as a new member; the
   old one shows as not live in `scripts/cluster.sh status` (on any other node), and so does the
   old object store node under "failed nodes".
2. Remove the lost database member (the id is in `status`). This waits until the cluster
   declares the member dead, five minutes by default, and then moves its replicas:

   ```bash
   scripts/cluster.sh db-remove-node 3
   ```

3. Join the object store in the lost node's place, in one step, giving a healthy node's
   `node-id` and the lost node's id from `status`:

   ```bash
   scripts/cluster.sh garage-join 5c1f...@10.0.0.12:3901 --replace 40688d89e534a8e9
   ```

4. `scripts/cluster.sh up`.

The uploaded files are copied back onto the new node from the other copies in the background.
With two nodes and no witness the cluster has no majority while one is gone, so writes stop
until it is back; the steps are the same once a node is reachable again.
`tests/cluster/replace-node.sh` runs exactly this on a simulated cluster.

#### Removing a node for good

While the node is still running: `scripts/cluster.sh db-remove-node <id>` (the database moves
its replicas away) and `scripts/cluster.sh garage-remove-node <id>` (the object store moves its
copies away; it refuses if fewer nodes than the copy count would remain). Then stop the node,
take it out of the load balancer, and out of the other nodes' `CLUSTER_PEERS`. Keep the node
online until its data has moved (`scripts/cluster.sh status`).

#### A witness node

`NODE_ROLE=data` in a node's `.env` makes it a witness: it runs only the database and object
store, no application, and is not in the load balancer. Two application nodes plus a witness
(a small third host) survive losing any one of the three; without it, two nodes do not. Use
`scripts/cluster.sh start-data` on it (`up` does the same for a witness).

#### Backups

`make db-backup-s3` / `scripts/db-s3.sh --prod backup` back the database up into the object
store, which holds copies on several nodes, so any node can restore it. In a cluster the SQL
runs on the local node over its certificates. A restore replaces the database for everybody,
so it refuses to run while another node's application is up: stop it on the others
(`scripts/compose.sh --prod stop api web monitor`), run `scripts/db-s3.sh --prod restore
--confirm` on one node, and start the others again (`scripts/cluster.sh up`). The restore hands
the restored tables to the application's database user. Uploaded files are protected by the
object store's copies, not by that backup: back the whole store up separately (for example
`scripts/s3-copy.sh` to another store) if losing every node at once is a risk you take.

#### Converting a single node install to a cluster

This is not done in place: the single node's bundled database is insecure and a cluster's is
secure, and the object store becomes a cluster. Build the cluster next to the old install and
move the data across. Use the same `AUTH_SECRET` in both, since encrypted settings (SMTP
password, OAuth secrets) are readable only with it, and the object store keys are derived from
it too.

1. On the old install: `scripts/db-s3.sh --prod backup` (or without `--prod` on a dev stack).
2. Set up the cluster as in shape C **up to and including step 5** (certificates, start-data,
   init-db, garage-bootstrap). Do not migrate or seed.
3. Copy the uploaded files and the backup (they share one bucket) into the cluster's store.
   Set `CLUSTER_S3_API_PORT=3900` in one cluster node's `.env` and recreate its object store
   (`scripts/compose.sh --prod up -d garage`) so that its S3 port is reachable; then, on the old
   host, with the keys that `scripts/compose.sh --prod --s3-env` prints **on that cluster node**
   (the same two keys the old install uses, because they come from the same `AUTH_SECRET`):

   ```bash
   scripts/s3-copy.sh --prod --to-endpoint http://10.0.0.11:3900 \
       --to-access-key GK... --to-secret-key ... --to-region garage
   ```

   Run it again after stopping the old application for the final pass (it only copies what is
   missing, and verifies by content). Then take `CLUSTER_S3_API_PORT` out of `.env` and
   recreate that node's object store again.
4. On one cluster node: `scripts/db-s3.sh --prod restore --confirm`. Then
   `scripts/cluster.sh migrate` (applies any newer migrations), and `scripts/cluster.sh up` on
   every node.
5. Point the load balancer at the cluster nodes and retire the old install.

The pieces are each exercised by the test suite (the backup and restore with its hand-over of
the restored tables, the copy between stores, the cluster itself), but the conversion as a
whole has not been run on a real install: do it on a copy first. Use `--prod` on `s3-copy.sh`
and `db-s3.sh` only when the old install is the production stack.

#### Operating a multi node deployment

- **Upgrades go one node at a time**: run migrations once, then for each node
  `scripts/cluster.sh drain` (its `/healthz` answers 503 and the load balancer stops sending
  new requests; requests and WebSocket connections already open are not cut, so wait for them
  to finish), upgrade it, `scripts/cluster.sh undrain`, and wait for the load balancer to see
  it healthy before the next. `scripts/cluster.sh status` shows a node's health check and
  whether it is drained. Every migration must work with the previous release, because for a
  while nodes run different versions. A browser tab left open across an upgrade may need a
  reload (it loads scripts named by the old build, and its realtime connection, which
  predates the WebSocket-only change if you are upgrading from an older release, is
  refused until it does). Destructive schema changes ship across two releases.
- **A node fails**: the load balancer stops sending it traffic, and its background jobs move
  to another node within about 30 seconds (measured: a killed node's leases expired within 10
  seconds). Rejoining it is automatic: start it again. A node whose database has lost its
  majority answers `/healthz` with 503 within a few seconds, so the load balancer stops using
  it, instead of keeping it in rotation while every request hangs.
- **Backups**: shape C backs up the database to the shared object store, so any node can
  restore it (see [Backups](#backups)). In shape D the database backups are yours.
- **Visibility**: `scripts/cluster.sh status` on a node shows its health check, the database
  members and the object store nodes. An admin Cluster page (every node, its last heartbeat and
  version, and which node runs each background job) is planned and not built yet; the data is
  in the `cluster_nodes` and `cluster_leases` tables meanwhile.
- **Known behaviours**: realtime updates from another node can arrive up to a second
  later; search can lag by a second or two across nodes; the general API rate limit is per
  node (the sign-in limit is cluster-wide); a mail may be sent by a different node than the
  one that accepted the request.

## Environment variables

`.env` is intentionally minimal — it holds only **bootstrap** values (things needed
before the DB is reachable, or that wire one container to another). Everything an
operator tunes at runtime — site name, SMTP, Google/Microsoft OAuth, UniFi,
ProPresenter, Planning Center, auth feature flags — lives in the `settings` table and
is edited at `/admin/settings`. `make up` writes `.env` from `.env.example` with a
random `AUTH_SECRET`. The full annotated list is in `.env.example`; the ones you'll
touch:

| Var | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | yes | Signs session cookies + derives the web↔api internal token. `openssl rand -hex 32`. Must be identical in `web` and `api` (it is by default). |
| `EXTERNAL_PORT` | no | Host port for Caddy — the public entrypoint (default `8100`). |
| `COCKROACH_UI_PORT` | no | Loopback-only host port for the dev Cockroach admin UI (default `8180`; bundled database only). |
| `COCKROACH_LOG_DIR` | no | Host folder for the dev Cockroach logs (default `./data/cockroach-logs`; bundled database only). Use local disk if `./data` is on NFS. |
| `S3_MODE` | no | `bundled` (default) or `external`. See [Choosing the object store](#choosing-the-object-store). |
| `GARAGE_META_DIR` | no | Where the bundled Garage keeps its metadata database (default `./data/garage/meta`). Must be local disk, not NFS. |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | with `S3_MODE=external` | The external store. Also `S3_REGION`, `S3_USE_SSL`, `S3_PATH_STYLE`, `S3_SESSION_TOKEN`. |
| `MEILI_MASTER_KEY` | yes in prod | Meilisearch master key (dev uses a throwaway key). |
| `DB_MODE` | no | `bundled` (default) or `external`. See [Choosing a database](#choosing-a-database). |
| `DATABASE_URL` | with `DB_MODE=external` | Connection string for the external database. Leave unset for the bundled one. (`COCKROACH_URL`, the old name, is still read by the apps.) |
| `MINIO_ENDPOINT` / `MINIO_BUCKET` / `MINIO_USE_SSL` / `MINIO_REGION` / `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | no | The older names for the `S3_*` settings (the last two as the keys), still read for an external store when the `S3_*` one is unset. |
| `API_INTERNAL_URL` / `WEB_INTERNAL_URL` | no | In-stack service URLs; don't change unless rewiring compose. |
| `NODE_ENV` / `LOG_LEVEL` | no | Runtime mode + log verbosity. |
| `NODE_ID` | no | This app node's name (default `main`); must be unique per node and stable across restarts. Required (and different on every node) with `DEPLOY_MODE=cluster`; see [multi node](#multi-node-shapes-c-and-d). |
| `DEPLOY_MODE` | no | `single` (default) or `cluster`, production stack only. A cluster node also needs `NODE_ID`, and with the bundled database or object store `NODE_ADDR` and `CLUSTER_PEERS` ([shape C](#shape-c-bundled-database-on-every-node)). |
| `NODE_ADDR` / `CLUSTER_PEERS` | cluster, bundled database or object store | This node's address as the others reach it, and the other nodes' addresses (comma separated; `host:dbport:rpcport` where a node uses non-default ports). |
| `CLUSTER_BIND_ADDR` / `CLUSTER_DB_PORT` / `CLUSTER_S3_RPC_PORT` | no | Which host interface, and which ports, the cluster ports are published on (defaults: all interfaces, `26257`, `3901`). |
| `CLUSTER_S3_CAPACITY` / `GARAGE_REPLICATION_FACTOR` / `CLUSTER_S3_API_PORT` | no | What each node offers the object store (default `100G`, a ceiling), the number of copies (set when the cluster is created; default 3 with three or more nodes, else 2), and an optional published S3 port for copying files in or out. |
| `NODE_ROLE` | no | `full` (default) or `data`: a [witness](#a-witness-node) runs only the database and object store. |
| `TRUSTED_PROXIES` | no | Load balancer CIDRs the proxy believes `X-Forwarded-For` from (space-separated). See [multi node requirements](#requirements). |
| `BUILD_ID` / `API_IMAGE` / `WEB_IMAGE` / `MONITOR_IMAGE` | no | The build's name (default: from git) and pre-built images to run instead of building, for a cluster; `scripts/release.sh` prints them. |
| `BACKUP_MAX_UPLOAD_BYTES` | no | Largest backup file accepted by Admin > Backups > Restore > Upload (default 5 GiB). |
| `BACKGROUND_JOBS` | no | `off` keeps this node from taking any periodic job (polling, schedulers), for a node that cannot reach the monitored devices. Default `on`. |

`APP_URL` and `AUTH_URL` are **intentionally unset** — Auth.js derives the public origin
from the request `Host` header so the app works at any hostname with zero config. Only
set them if a proxy strips *both* `Host` and `X-Forwarded-Host`. (Links in outbound
email use the **Site URL** setting in `/admin/settings` first, then `APP_URL`, then the
origin of the triggering request — set Site URL so emailed links aren't `localhost`.)

> OAuth client IDs/secrets, the workspace domain, and SMTP are **not** env vars —
> configure them at `/admin/settings` after first boot. Earlier versions of this doc
> listed `GOOGLE_OAUTH_*`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SMTP_*`, etc.; those are gone,
> the API reads them from the DB only.

## Single sign-on (optional)

OAuth is configured entirely in the browser at `/admin/settings` — no `.env` edits, no
redeploy (changes take effect within ~1 minute). Local accounts work without any of this.

### Google

1. In Google Cloud Console, create (or pick) a project and create an **OAuth 2.0 Client
   ID** of type **Web application**.
2. For the **Authorized redirect URI**, paste the value shown on `/admin/settings/google`
   — it's derived from the host you're on (e.g.
   `https://dashboard.example.org/api/auth/callback/google`).
3. Paste the Client ID + secret into `/admin/settings/google` and save. Use **Test
   Google OAuth** to confirm the credentials, then turn on "Allow sign-in with Google".
   (The toggle won't enable until the ID and secret are present.)
4. **Workspace domain** (optional): set it to auto-accept everyone on that domain into
   the default `user` group. Leave blank to allow any Google account.
5. **Allow external accounts (with approval)** (optional): lets non-domain Google
   accounts sign in but holds them *pending* until an admin approves them under
   `/admin/users` → Pending. Useful for volunteers.

### Microsoft (Entra ID)

1. Register an app in the Entra admin centre and add a **Web** redirect URI of the value
   shown on `/admin/settings/microsoft` (ends with `/api/auth/callback/microsoft-entra-id`).
2. Create a client secret, then paste the Application (client) ID + secret into
   `/admin/settings/microsoft`, set the tenant (`common` / `organizations` / a tenant id),
   optionally restrict by email domain, and enable it.

> Google **Groups sync** (Workspace Directory API) is **not implemented** — the "Sync
> Google Groups" admin action is currently a stub. Manage groups and per-module access
> locally under `/admin` for now.

If you skip SSO entirely, the app still works with local accounts and locally managed
groups.

## Production

```bash
cp .env.example .env
$EDITOR .env                   # bootstrap secrets (AUTH_SECRET, MEILI_MASTER_KEY) + DB_MODE/DATABASE_URL
scripts/compose.sh --prod up -d --build
scripts/compose.sh --prod exec api node dist/scripts/migrate.js
scripts/compose.sh --prod exec api node dist/scripts/seed.js
```

Then sign in as **admin / admin**, change the password, and configure SMTP and any OAuth
providers at `/admin/settings` — none of that is env-based.

The prod compose file:
- Runs a 3-node CockroachDB cluster with persistent volumes (with `DB_MODE=bundled`);
  all three nodes are on this one host, see [Deployment shapes](#deployment-shapes-single-node-and-multi-node)
- Publishes no object-store port (Garage is reachable only on the stack's network)
- Restarts on failure (`restart: unless-stopped`)
- Locks every non-proxy port behind the internal compose network

Behind your load balancer, terminate TLS and proxy HTTP to the host's `:EXTERNAL_PORT`.
Set `X-Forwarded-Proto: https` and `X-Forwarded-For: <client ip>` on the LB; Caddy
trusts these by default in our config.

## Using the API

Scripts and agents use the same REST API as the web UI, at
`https://<your-host>/api/v1/...`, authenticated with a personal **API token** sent as a
bearer header. Create one at **API tokens** in the user menu (`/me/api-tokens`).

```bash
TOKEN=cdt_...   # shown once, when you create it
curl -H "Authorization: Bearer $TOKEN" https://<your-host>/api/v1/me

# list tickets
curl -H "Authorization: Bearer $TOKEN" https://<your-host>/api/v1/tickets

# create a ticket (needs a read-and-write token)
curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"title":"Projector in room 2 is flickering","description":"Started Sunday.","priority":"normal"}' \
  https://<your-host>/api/v1/tickets
```

How tokens behave:

- **A token acts as you.** It can never do more than your account can, right now: if your
  groups change, so does what the token can do, and it stops working if your account is
  disabled or deleted. Every change it makes is in the audit log as you, "via token" and
  its name.
- **Read-only** tokens (the default) can call any `GET`; every `POST`, `PUT`, `PATCH` or
  `DELETE` gets `403`.
- **Module limits** keep only what those modules grant. A token limited to the wiki gets
  `403` on, say, `/api/v1/users`, and results such as search leave out other modules.
- **Every token expires**, within the limit an admin sets (365 days by default; an admin
  can allow tokens that never expire). An expired, revoked or unknown token gets `401`.
- **Some things need a signed-in browser**: creating or revoking tokens, changing your
  password, email or two-factor settings. A token gets `403` there, so a leaked token
  can't make new tokens or take over the account.

Admins see and revoke every token at `/admin/api-tokens`, can issue a token to another
user (for a service account) from that user's **Manage** drawer, and set the lifetime
limit or turn tokens off entirely at `/admin/settings/auth`. Turning tokens off makes
every existing token fail straight away, without deleting any.

To act as something other than yourself, such as a backup script or an AI agent, create a
user for it and issue the token to that user, so its changes are attributed to it.

## Connecting Claude (MCP)

The dashboard is an [MCP](https://modelcontextprotocol.io) server at `/api/v1/mcp`,
so an AI agent such as a Claude Code session can read and write the wiki, for example
to document the systems and services it works on. It uses the same wiki code as the web
UI, so permissions, page ACLs, revisions, search and notifications all behave the same.

1. **Create a user for the agent** at `/admin/users`, e.g. "Claude (docs)", so its edits
   are attributed to it rather than to you. Give it a long random password (it never
   signs in) and put it in a group that has the wiki module. At the wiki *user* tier
   it can create pages and edit the ones it created (or ones whose access list gives
   its group edit rights). To let it update pages people wrote, give its group the
   wiki *admin* tier.
2. **Issue it an API token** limited to the wiki module, with read-write access: in
   `/admin/users`, open the agent's **Manage** drawer, expand **API tokens**, press
   **Issue token**, choose *Read and write* and *Only these: Wiki*, then copy the token
   it shows. It's shown only once. A read-only token also works: the agent can then
   search and read but every write tool is refused.
3. **Connect the agent** from the machine it runs on:

   ```bash
   claude mcp add --transport http church https://<your-host>/api/v1/mcp \
     --header "Authorization: Bearer <token>"
   ```

The endpoint only accepts API tokens; a browser session is refused. Set **Site URL** in
`/admin/settings/site` so the links the tools return are absolute.

| Tool | What it does |
|---|---|
| `wiki_search` | Find pages by words in the title or body |
| `wiki_get_page` | Read one page (Markdown body, location, `updatedAt`) |
| `wiki_tree` | The folder and page hierarchy |
| `wiki_list_revisions` | A page's edit history |
| `wiki_create_page` | Create a page, optionally in a folder or under a page |
| `wiki_update_page` | Change a page's title, body or location |
| `wiki_create_folder` | Create a folder |

Safety: `wiki_update_page` needs the `updatedAt` the agent last read, so it can't
overwrite an edit made since. Every edit is a revision you can revert from the page's
history, and there is no delete tool. To keep an agent inside one area, give its group
edit rights only on pages in that area (page ACLs). Each change is audited as the agent's
user; reads aren't.

## Dockerized commands (no Node on host)

Every `make` target below can also be run via a one-off node container:

```bash
# install / lockfile
docker run --rm -v "$PWD":/w -w /w node:20-alpine sh -c 'corepack enable && pnpm install'

# typecheck
docker run --rm -v "$PWD":/w -w /w node:20-alpine sh -c 'corepack enable && pnpm typecheck'

# unit tests
docker run --rm -v "$PWD":/w -w /w node:20-alpine sh -c 'corepack enable && pnpm test'
```

The `Makefile` wraps these so you can just `make install`, `make typecheck`, `make test`.

## Backups and restores in the app (admin > Backups)

Administrators with `site:admin` can back up everything the dashboard holds from **Admin >
Backups**, on a schedule or on demand, download a copy to keep offline, and roll the whole site
back to any of them with a report of exactly what would change. It is the safety net for
"somebody deleted something" and "we need to go back to how it was last week". It is separate
from the operator-level backups under [Data & backup](#data--backup) (a copy of the database
servers' files, or Cockroach's own `BACKUP`), which remain the answer to losing a machine.

**What a backup is.** One `.tar.gz` file: every table that matters as JSON lines, and (unless you
untick "Include uploaded files") every uploaded file. Any archive tool can open it. The tables are
read in a single read-only transaction, so they agree with each other as of one moment. It works
the same on CockroachDB and YugabyteDB, since it reads and writes ordinary rows, and on a single
node or a cluster. **What it does not contain**, on purpose (`apps/api/src/backup/table-registry.ts`
decides this per table, and a unit test fails if a new table is added without a decision):
the audit log (a record of what happened must not be rewound), anything the system rebuilds by
itself (polled switch and metric history, search documents, the DNS sync ledger), per-node runtime
state (leases, queues, realtime events), sign-in sessions and one-time tokens, and the backup
list itself.

**The three tabs.**

- **Backups**: make one now (name optional), see every backup with its size and contents,
  download, rename, delete. A download is two steps (an audited request returns a link that works
  for five minutes and only for the person who asked), then the file streams straight from storage.
- **Schedules**: daily, weekly or monthly at a time of day in a time zone you choose (daylight
  saving is followed), keeping the latest N backups of that schedule and deleting older ones.
  Several schedules are fine (a nightly one that keeps a week and a monthly one that keeps a year).
  A failed scheduled backup notifies the administrators (the `backup.failed` notification kind).
  Only the node leading the `backup-scheduler` job makes them, so a cluster makes each once.
- **Restore**: pick a backup from the list, or **upload** a `.tar.gz` (one downloaded earlier, or
  from another installation). An uploaded file is checked end to end (every row count and every
  file's SHA-256) before it is offered. **Compare** shows what a restore would do to the data
  as it is now, grouped by area, with the rows by name (a ticket's title, a user's name) and, for a
  row that was edited, each changed column with its value now and in the backup. Secrets show only
  that they differ. It also lists files that would come back or be deleted, says what would happen
  to your own account (a restore can remove the very administrator who runs it), and lists
  problems and warnings. Then **Restore**, which needs the box ticked or unticked as you
  choose and the word `RESTORE` typed.

**What a restore does.** It is a full rollback: afterwards the data matches the backup. Rows added
since are deleted, rows deleted since come back, rows edited since are put back as they were, and
uploaded files follow (files made since are removed, missing ones are put back and checked
against the checksum recorded in the backup). All of it happens in **one database transaction**:
a failure part way, including a constraint, leaves the database exactly as it was. Two kinds of
column are left alone because pollers rewrite them every few seconds and rewinding them would only
make the data wrong: live status columns (a monitor's last check, a printer's toner level), which
the report also ignores so it is not full of changes nobody made.

While it runs, on every node, **changes are refused** (503, "a backup is being restored"),
reads keep working, periodic jobs skip their runs and the monitor worker pauses. By default a
**safety backup** of the current data is made first and kept in the list as a "Safety copy"
(the newest five are kept), so a restore can be undone by restoring that; the box that turns this
off is there for a reason: without it nothing can bring back what the restore removes. When it
finishes, caches are cleared on every node and search is rebuilt in the background; people may be
asked to sign in again if their account changed.

**Compatibility.** A backup from an older release restores into a newer one (columns added since
get their defaults; the report says so); one from a newer release is refused with a message. Saved
SMTP, OAuth and device passwords are encrypted with `AUTH_SECRET`: a backup records a fingerprint
of it, and restoring onto an installation with a different one needs an explicit "go ahead anyway"
and means re-entering those secrets. Moving a site to another installation is therefore: set up the
new one with the same `AUTH_SECRET`, upload the backup, restore.

**Things to know.**

- A backup holds password hashes and encrypted secrets. Treat downloaded files as private. Backups
  are available only to a signed-in browser session, never to an API token.
- Backups are stored in the object store (the same bucket as the uploads, under `backups/`), so
  they share its fate: losing the store loses the backups with it. Download copies you cannot
  afford to lose, and keep the operator-level backups too (they also cover the audit log and
  history).
- A restore runs as one transaction, so it either completes or changes nothing. Measured on a
  deliberately slow setup (a single-node CockroachDB whose data directory is on NFS): about 26,500 rows
  restored into an empty database in 20 seconds; 262,300 rows holding about 200 MB of text (a site
  many times a church's size) backed up in 7 seconds, compared in 17 seconds using about 340 MB of
  memory, and restored into an empty database in 4 minutes, or rewound by 23,600 changes in under 2
  minutes. Writes are paused for the whole restore, so for a very large site pick a quiet hour. The
  polled history that makes databases large is excluded from backups; a site with many millions of
  rows in the backed-up tables could meet the database's transaction limits (not tried).
- If the node running a restore dies, the pause on changes lapses by itself within about 40 seconds
  and the data is untouched (the transaction never committed); the abandoned operation is marked
  failed within a few minutes. Tested by killing the node mid-restore (`tests/cluster/restore-node-death.py`).
- Only one backup, upload, comparison or restore runs at a time on the whole cluster; a second request
  is told so. Uploads are limited to 5 GiB by default (`BACKUP_MAX_UPLOAD_BYTES`).
- Archives with no record (a delete that failed, a node that died mid-upload) are swept up
  automatically every half hour.

**Testing.** The engine has integration tests against a real database that run on CockroachDB and on
YugabyteDB (`apps/api/test/backup.integration.test.ts`, with `TEST_DATABASE_URL`), unit tests for the
archive format, the schedule arithmetic and the table registry, smoke and browser tests for the pages
(which never restore on a live stack), and `tests/cluster/backup-restore.sh`, which does the whole thing
for real across the three nodes of the throwaway cluster (and `restore-node-death.py`, which kills the
node doing a restore): back up on one node, compare on another, restore
on the second while writes through the third are probed (refused during, accepted after), check the data
and a restored file byte for byte, search, undo the restore from the safety copy, move a backup through
download and upload, and let a schedule fire.

## Data & backup

These are the operator-level backups of the servers' own storage. For backups an administrator
makes and restores from the web UI (including scheduled ones), see
[Backups and restores in the app](#backups-and-restores-in-the-app-admin--backups).

All stateful data lives under `./data/` in the project directory via bind mounts:

```
./data/cockroach-1/    # CockroachDB store (DB tables, audit log, users, …)
./data/cockroach-2/    # (prod only) second cluster node
./data/cockroach-3/    # (prod only) third cluster node
./data/garage/data/    # uploaded files (wiki attachments, note images, …), Garage's data blocks
./data/garage/meta/    # Garage's metadata database, unless GARAGE_META_DIR puts it elsewhere (local disk!)
./data/meili/          # Meilisearch indexes
./data/caddy/          # Caddy state
./data/caddy-config/   # Caddy auto-generated config
```

For a full point-in-time backup, stop the stack and tar the directory:

```bash
make down
tar -czf backup-$(date +%F).tgz data/
make up
```

For a database-only backup that doesn't need downtime (bundled CockroachDB only):

```bash
make db-backup                 # writes ./backups/crdb-YYYYMMDD-HHMMSS.tgz
make db-restore FILE=./backups/crdb-20261003-233752.tgz CONFIRM=yes
```

The archive is a native CockroachDB `BACKUP` (not SQL), so it restores only into
CockroachDB. `db-restore` replaces the whole `church` database: it stops the api, web and
monitor containers, restores into a temporary database, and only once that has succeeded
swaps it in for the live one and starts them again. Without `CONFIRM=yes` it only says
what it would do. These targets use the dev compose file; for the prod stack, take a
`tar` of `data/` as above.

That archive is local to the host. To keep a backup in the object store instead, so it
survives the host and any node can restore it:

```bash
make db-backup-s3                       # BACKUP DATABASE into s3://<bucket>/db-backups/
make db-list-s3                         # what is there
make db-restore-s3 CONFIRM=yes          # replace church with the latest backup
make db-backup-s3 PROD=1                # the prod stack
```

(`scripts/db-s3.sh`.) It uses the same `S3_*` settings and works with the bundled Garage or an
external store (the bucket must exist: Cockroach does not create it). A restore stops the api, web
and monitor, restores into a copy, and swaps it in only once that has succeeded, so a failed
restore leaves the live database untouched; on a fresh cluster with no `church` database it
restores straight into place. Tested by backing up a database of 1.8 million rows into one
store and restoring it into a different cluster. Like the tarball, this is the bundled
CockroachDB only: an external database is backed up with its own tooling. The backups sit in
the same bucket as the uploads, so back that bucket up too if it is the bundled Garage.

In production, schedule one of these from cron. A backup that stays on the host is not a
backup: copy the tarballs off-box, or use the object-store form against a store elsewhere.

## Port collisions

`make up` runs `make check-ports` first. If any host-bound port (`EXTERNAL_PORT`,
`COCKROACH_UI_PORT`) is already taken by something *outside* this stack, the check
fails with a suggested free port and the env var to set. Edit `.env` and re-run.

Internal container ports (Next.js on `:3000`, NestJS on `:3001`) are **not** exposed
to the host — they live on the `church_internal` docker bridge — so collisions with
other host processes on those ports do not affect this stack.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `make up` aborts with "port in use" | another project on the host already binds that port | follow the suggestion the script prints — set the var in `.env` and re-run |
| `http://localhost:8100` 502 | api or web not yet healthy | `make logs`, wait for both to report ready |
| Cockroach won't start | volume from previous version | `make nuke` (DESTROYS DATA), then `make up` |
| Google sign-in fails with `redirect_uri_mismatch` | redirect URI in the OAuth client doesn't match | Copy the exact URI shown on `/admin/settings/google` into the client's Authorized redirect URIs |
| Enabled a provider but no sign-in button appears | toggle on but credentials missing, or cache | The button needs client ID + secret saved; provider config caches ~1 min — wait and reload `/signin` |
| Sessions log out on every request | `AUTH_SECRET` not stable | Ensure `.env` is mounted into both `web` and `api` (it is by default) |
| Audit log empty after mutations | hitting an unaudited route or interceptor disabled | Check the route exists in `apps/api/src` and the controller is under a module that imports `AuditModule` |

For anything else, `make logs` and grep for `error`. If it's a code bug, file an issue.

## Uninstall / wipe

```bash
make down       # stop containers, keep volumes (data preserved)
make nuke       # stop + delete all volumes (DESTROYS ALL DATA)
```
