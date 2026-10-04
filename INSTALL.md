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
- MinIO (S3) on internal `:9000` — console **not** exposed by default (uncomment the `MINIO_CONSOLE_PORT` line in `infra/docker-compose.yml` to reach it at <http://localhost:19090>)
- Meilisearch on internal `:7700` (throwaway dev master key, no host port)
- Redis on internal `:6379`
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
- **Backups are yours.** `make db-backup` only covers the bundled database; use
  `ysql_dump` or `cockroach BACKUP` for an external one.

`scripts/compose.sh` reads `DB_MODE` and `DATABASE_URL`, switches the bundled database
(the `bundled-db` compose profile) on or off, and runs `docker compose`. Every `make`
target goes through it. If you run compose by hand, use the script
(`scripts/compose.sh ps`, `scripts/compose.sh --prod up -d`), or export `DATABASE_URL`
yourself and add `--profile bundled-db` for the bundled database.

Switching an existing install between databases moves no data. Export from the old one
and import into the new one with that engine's tools before changing `DB_MODE`.

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
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | yes | MinIO credentials — set a real password before prod. |
| `MEILI_MASTER_KEY` | yes in prod | Meilisearch master key (dev uses a throwaway key). |
| `DB_MODE` | no | `bundled` (default) or `external`. See [Choosing a database](#choosing-a-database). |
| `DATABASE_URL` | with `DB_MODE=external` | Connection string for the external database. Leave unset for the bundled one. (`COCKROACH_URL`, the old name, is still read by the apps.) |
| `REDIS_URL` | no | Redis URL; defaults to in-stack `redis:6379`. |
| `MINIO_ENDPOINT` / `MINIO_BUCKET` / `MINIO_USE_SSL` / `MINIO_REGION` | no | MinIO wiring; in-stack defaults are fine. |
| `API_INTERNAL_URL` / `WEB_INTERNAL_URL` | no | In-stack service URLs; don't change unless rewiring compose. |
| `NODE_ENV` / `LOG_LEVEL` | no | Runtime mode + log verbosity. |

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
$EDITOR .env                   # bootstrap secrets (AUTH_SECRET, MinIO creds, MEILI_MASTER_KEY) + DB_MODE/DATABASE_URL
scripts/compose.sh --prod up -d --build
scripts/compose.sh --prod exec api node dist/scripts/migrate.js
scripts/compose.sh --prod exec api node dist/scripts/seed.js
```

Then sign in as **admin / admin**, change the password, and configure SMTP and any OAuth
providers at `/admin/settings` — none of that is env-based.

The prod compose file:
- Runs a 3-node CockroachDB cluster with persistent volumes (with `DB_MODE=bundled`)
- Drops the MinIO console exposure (admin via `mc` inside the container)
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

## Data & backup

All stateful data lives under `./data/` in the project directory via bind mounts:

```
./data/cockroach-1/    # CockroachDB store (DB tables, audit log, users, …)
./data/cockroach-2/    # (prod only) second cluster node
./data/cockroach-3/    # (prod only) third cluster node
./data/redis/          # Redis save-files
./data/minio/          # uploaded files (wiki attachments, note images, …)
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

In production, schedule one of these from cron. Backups are local to the host — copy them
off-box too.

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
