# Install & operate

## Prerequisites

- **Docker** 25+ with the Compose plugin (`docker compose version` should report v2.x)
- A free **host port 8100** (configurable via `EXTERNAL_PORT` in `.env`)
- A Google Workspace domain (free for nonprofits) for SSO + group sync, OR you can run
  with local accounts only and add Google later

You do **not** need Node.js or pnpm on the host. Every dev/admin command has a
docker-only equivalent — see [the dockerized commands section](#dockerized-commands-no-node-on-host).

## Quick start (dev)

```bash
git clone <this repo>
cd church-dashboard
make up                        # auto-generates .env, creates ./data/ bind mounts, starts stack
make migrate                   # applies SQL migrations to Cockroach
make seed                      # creates default roles + default admin
make logs                      # tail everything
```

Then open <http://localhost:8100> and sign in with:

| Username | Password |
|---|---|
| `admin` | `admin` |

You will be required to set a new password on first login. After that, runtime configuration
(Google OAuth, SMTP, site name, etc.) lives in the database — edit it at `/admin/settings`,
no file editing needed.

If you ever need the default back (CI, regression testing, lost password): `make reset-admin`.

The dev stack includes:
- Single-node CockroachDB on internal `:26257` (web UI at <http://localhost:8180>)
- MailHog SMTP sink at <http://localhost:8025>
- MinIO console at <http://localhost:9090>
- Meilisearch at internal `:7700` (no auth in dev)
- Redis on internal `:6379`

## Environment variables

See `.env.example` for the full list. The most important ones:

| Var | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | yes | Signs session cookies. Generate with `openssl rand -hex 32`. |
| `EXTERNAL_PORT` | no | Host port for Caddy — the public entrypoint (default `8100`). |
| `COCKROACH_UI_PORT` | no | Host port for the dev Cockroach admin UI (default `8180`). |
| `MAILHOG_UI_PORT` | no | Host port for the dev MailHog inbox (default `18025`). |
| `APP_URL` | yes | Public base URL (e.g. `https://dashboard.example.org`). Used in emails and OAuth redirects. |
| `GOOGLE_OAUTH_CLIENT_ID` | no | Google OAuth client id. If unset, only local auth is available. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | no | Matching client secret. |
| `GOOGLE_WORKSPACE_DOMAIN` | no | e.g. `mychurch.org`. If set, restricts Google sign-in to this domain. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | Path (in container) to a JSON key for Workspace Admin SDK. Required for Google Groups sync. |
| `GOOGLE_ADMIN_IMPERSONATE` | no | Workspace admin email the service account impersonates for Directory API. |
| `SMTP_*` | yes in prod | Real SMTP server for notifications. Dev uses MailHog automatically. |
| `COCKROACH_URL` | no | Override DB URL. Defaults to in-stack `cockroach-1:26257`. |
| `REDIS_URL` | no | Override Redis URL. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | yes | MinIO admin credentials. |
| `MEILI_MASTER_KEY` | yes in prod | Meilisearch master key. Dev uses a dev key. |

## Google Workspace setup (optional but recommended)

1. In Google Cloud Console, create a project for the church.
2. Enable **Admin SDK API** and **People API**.
3. Create an **OAuth 2.0 Client ID** (Web application). Authorized redirect URI:
   `https://<APP_URL>/api/auth/callback/google`.
   Put the client id/secret in `.env`.
4. Create a **service account** with **domain-wide delegation** enabled.
   - In the Workspace Admin Console → Security → API controls → Domain-wide delegation,
     authorize the service account's client ID with these scopes:
     - `https://www.googleapis.com/auth/admin.directory.group.readonly`
     - `https://www.googleapis.com/auth/admin.directory.user.readonly`
5. Download the service account JSON key, mount it into the `api` container
   (compose already binds `./secrets/google-sa.json` if it exists), and set
   `GOOGLE_SERVICE_ACCOUNT_JSON=/run/secrets/google-sa.json` and
   `GOOGLE_ADMIN_IMPERSONATE=<a Workspace admin email>`.
6. In the admin UI, click **Sync Google Groups** to pull groups in.

If you skip this section, the app still works — just with local accounts and locally
managed groups.

## Production

```bash
cp .env.example .env
$EDITOR .env                   # set everything; APP_URL, real SMTP, MinIO creds, etc.
docker compose -f infra/docker-compose.prod.yml up -d --build
docker compose -f infra/docker-compose.prod.yml exec api node dist/scripts/migrate.js
docker compose -f infra/docker-compose.prod.yml exec api node dist/scripts/seed.js
```

The prod compose file:
- Runs a 3-node CockroachDB cluster with persistent volumes
- Drops MailHog (real SMTP from `SMTP_*` vars)
- Drops the MinIO console exposure (admin via `mc` inside the container)
- Restarts on failure (`restart: unless-stopped`)
- Locks every non-proxy port behind the internal compose network

Behind your load balancer, terminate TLS and proxy HTTP to the host's `:EXTERNAL_PORT`.
Set `X-Forwarded-Proto: https` and `X-Forwarded-For: <client ip>` on the LB; Caddy
trusts these by default in our config.

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

For a hot logical DB-only backup that doesn't require downtime:

```bash
make db-backup                 # writes ./backups/cockroach-YYYYMMDD-HHMM.sql.gz
make db-restore FILE=./backups/cockroach-20260525-1830.sql.gz
```

In production, schedule one of these from cron. Backups are local to the host — copy them
off-box too.

## Port collisions

`make up` runs `make check-ports` first. If any host-bound port (`EXTERNAL_PORT`,
`COCKROACH_UI_PORT`, `MAILHOG_UI_PORT`) is already taken by something *outside* this
stack, the check fails with a suggested free port and the env var to set. Edit `.env`
and re-run.

Internal container ports (Next.js on `:3000`, NestJS on `:3001`) are **not** exposed
to the host — they live on the `church_internal` docker bridge — so collisions with
other host processes on those ports do not affect this stack.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `make up` aborts with "port in use" | another project on the host already binds that port | follow the suggestion the script prints — set the var in `.env` and re-run |
| `http://localhost:8100` 502 | api or web not yet healthy | `make logs`, wait for both to report ready |
| Cockroach won't start | volume from previous version | `make nuke` (DESTROYS DATA), then `make up` |
| Google sign-in fails with `redirect_uri_mismatch` | OAuth redirect URI wrong | Confirm it ends with `/api/auth/callback/google` and `APP_URL` matches |
| Sessions log out on every request | `AUTH_SECRET` not stable | Ensure `.env` is mounted into both `web` and `api` (it is by default) |
| Audit log empty after mutations | hitting an unaudited route or interceptor disabled | Check the route exists in `apps/api/src` and the controller is under a module that imports `AuditModule` |

For anything else, `make logs` and grep for `error`. If it's a code bug, file an issue.

## Uninstall / wipe

```bash
make down       # stop containers, keep volumes (data preserved)
make nuke       # stop + delete all volumes (DESTROYS ALL DATA)
```
