# Quick start

The shortest path from nothing to a signed-in dashboard. Every step links to
[INSTALL.md](./INSTALL.md), the full reference, if you need more.

## 1. You need

- A Linux host with Docker and the Compose plugin v2.20 or newer. If you don't have
  them: `curl -fsSL https://get.docker.com | sh`
- `git` and `make` (`sudo apt install git make` on Debian/Ubuntu)
- Port 8100 free on the host
- Roughly 4 GB of RAM and 10 GB of free disk

More: [Prerequisites](./INSTALL.md#prerequisites).

## 2. Get the code

```bash
git clone https://github.com/paintballrefjosh/church_tech_dashboard church-dashboard
cd church-dashboard
make init-env      # writes .env with a random AUTH_SECRET
```

## 3. Pick a database

The default needs no changes. For any other option, edit `.env` as shown.

| Option | Pick it when | What to do |
|---|---|---|
| Bundled CockroachDB, single node | You're trying it out or running a small install: everything lives in one stack | Nothing. It's the default. |
| Bundled CockroachDB, 3 nodes | You want the production compose file. All three nodes run on this one host, so it uses more memory without real host-level resilience. | Set real values for `MINIO_ROOT_PASSWORD` and `MEILI_MASTER_KEY` in `.env`. |
| External YugabyteDB | You already run YugabyteDB, or want to avoid CockroachDB's licence terms | `DB_MODE=external` and `DATABASE_URL=postgresql://user:pass@host:5433/church`. Create the `church` database first; on 2024.2 LTS the user must be allowed to enable `pgcrypto`. |
| External CockroachDB | You already run a CockroachDB cluster | `DB_MODE=external` and `DATABASE_URL=postgresql://user:pass@host:26257/church`. Create the `church` database first. |

CockroachDB's licence terms changed in late 2024; check they suit you before choosing a
Cockroach option. For an external database, `host` must be reachable from inside the
containers, so don't use `localhost`.

More: [Choosing a database](./INSTALL.md#choosing-a-database).

## 4. Start it

The first build takes about 5 to 10 minutes.

Single node or an external database:

```bash
make up
make migrate
make seed
```

Bundled 3 nodes (the production compose file):

```bash
make prod-up
scripts/compose.sh --prod exec api node dist/scripts/migrate.js
scripts/compose.sh --prod exec api node dist/scripts/seed.js
```

If `make migrate` says the api container isn't running, give it a minute to finish
starting and run it again. `make logs` shows what each service is doing.

More: [Production](./INSTALL.md#production), [Troubleshooting](./INSTALL.md#troubleshooting).

## 5. Sign in

Open `http://<server>:8100` and sign in as `admin` with password `admin`. You'll be asked
to set a new password straight away.

## 6. Set the Site URL

Go to `/admin/settings/site` and set **Site URL** to the address people use to reach the
dashboard, so links in emails point at the right place.

## Next

- **Email:** enter your SMTP server at `/admin/settings/smtp`. Until you do, the dashboard sends no email.
- **Google or Microsoft sign-in:** [Single sign-on](./INSTALL.md#single-sign-on-optional).
- **HTTPS:** put a load balancer or reverse proxy in front that terminates TLS and forwards HTTP to port 8100. See [Production](./INSTALL.md#production).
- **Backups:** back up `data/` and `.env` together. See [Data & backup](./INSTALL.md#data--backup).
