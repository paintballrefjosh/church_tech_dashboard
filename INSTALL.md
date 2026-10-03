# Install & operate

## Prerequisites

- **Docker** 25+ with the Compose plugin (`docker compose version` should report v2.x)
- A free **host port 8100** (configurable via `EXTERNAL_PORT` in `.env`)
- Optionally, a Google and/or Microsoft (Entra) OAuth app for single sign-on — you can
  also run with local accounts only and add OAuth later. It's all configured in the
  browser at `/admin/settings`, not in files.

You do **not** need Node.js or pnpm on the host. Every dev/admin command has a
docker-only equivalent — see [the dockerized commands section](#dockerized-commands-no-node-on-host).

## Quick start (dev)

```bash
git clone <this repo>
cd church-dashboard
make up                        # auto-generates .env, creates ./data/ bind mounts, starts stack
make migrate                   # applies SQL migrations to Cockroach
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
- Single-node CockroachDB on internal `:26257` (admin UI at <http://localhost:8180>, `COCKROACH_UI_PORT`)
- Email: no bundled mail sink — configure a real SMTP server in `/admin/settings` (leave `smtp.host` blank to disable email). For local testing, point it at a throwaway SMTP catcher of your choice or your real mail server.
- MinIO (S3) on internal `:9000` — console **not** exposed by default (uncomment the `MINIO_CONSOLE_PORT` line in `infra/docker-compose.yml` to reach it at <http://localhost:19090>)
- Meilisearch on internal `:7700` (throwaway dev master key, no host port)
- Redis on internal `:6379`
- A `monitor` probe worker running the uptime checks

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
| `COCKROACH_UI_PORT` | no | Host port for the dev Cockroach admin UI (default `8180`). |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | yes | MinIO credentials — set a real password before prod. |
| `MEILI_MASTER_KEY` | yes in prod | Meilisearch master key (dev uses a throwaway key). |
| `COCKROACH_URL` | no | DB URL; defaults to in-stack `cockroach-1:26257`. |
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
$EDITOR .env                   # bootstrap secrets only: AUTH_SECRET, MinIO creds, MEILI_MASTER_KEY
docker compose -f infra/docker-compose.prod.yml up -d --build
docker compose -f infra/docker-compose.prod.yml exec api node dist/scripts/migrate.js
docker compose -f infra/docker-compose.prod.yml exec api node dist/scripts/seed.js
```

Then sign in as **admin / admin**, change the password, and configure SMTP and any OAuth
providers at `/admin/settings` — none of that is env-based.

The prod compose file:
- Runs a 3-node CockroachDB cluster with persistent volumes
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
