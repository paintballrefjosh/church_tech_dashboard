#!/usr/bin/env bash
#
# Shape D end to end (docs/multi-node.md, INSTALL.md "Shape D"): two app nodes that share a database
# and an object store they do not run, behind a load balancer, on one host.
#
#   tests/cluster/shape-d.sh up [cockroach|yugabyte]   build it (default: cockroach)
#   tests/cluster/shape-d.sh test                      run the checks against it
#   tests/cluster/shape-d.sh down                      remove everything
#
# What is real: each app node is a copy of the repository with its own .env (DEPLOY_MODE=cluster,
# DB_MODE=external, S3_MODE=external, nothing else cluster-specific) and its own compose project, so the
# real scripts run; the load balancer is a stock Caddy using the documented /healthz contract and round
# robin; the "your own database" is a throwaway CockroachDB or YugabyteDB container and "your own S3" a
# standalone Garage, both outside the app's compose projects.
# What is not: they all share one host, so there is no real network between them.
set -uo pipefail
cd "$(dirname "$0")/../.."
SIM="tests/cluster/sim.sh"
SIM_DIR="${SIM_DIR:-$HOME/church-sim}"
export SIM_DIR
HOST="${SIM_HOST:-$(hostname -I | awk '{print $1}')}"
export SIM_HOST="$HOST"
LB_PORT="${SHAPE_D_LB_PORT:-8300}"
DB_NAME=sd-db
S3_NAME=sd-s3
LB_NAME=sd-lb
S3_PORT=3920
CRDB_PORT=26401
die() { echo "shape-d: $*" >&2; exit 1; }
url() { echo "http://$HOST:$((8200 + $1))"; }
lb() { echo "http://$HOST:$LB_PORT"; }
rand_hex() { openssl rand -hex "$1"; }

STATE="$SIM_DIR/shape-d.env"

start_database() {
  local engine="$1"
  docker rm -f "$DB_NAME" >/dev/null 2>&1
  case "$engine" in
    cockroach)
      docker run -d --name "$DB_NAME" -p "$CRDB_PORT:26257" cockroachdb/cockroach:v24.2.0 \
       start-single-node --insecure >/dev/null
      for _ in $(seq 1 60); do docker exec "$DB_NAME" cockroach sql --insecure -e "select 1" >/dev/null 2>&1 && break; sleep 2; done
      docker exec "$DB_NAME" cockroach sql --insecure -e "CREATE DATABASE church" >/dev/null || die "could not create the database"
      DATABASE_URL="postgresql://root@$HOST:$CRDB_PORT/church?sslmode=disable"
      ;;
    yugabyte)
      # Host networking: YugabyteDB listens on its advertise address and has many ports.
      docker run -d --name "$DB_NAME" --network host yugabytedb/yugabyte:2024.2.3.0-b116 \
        bin/yugabyted start --background=false --advertise_address="$HOST" >/dev/null
      for _ in $(seq 1 90); do docker exec "$DB_NAME" bin/ysqlsh -h "$HOST" -c "select 1" >/dev/null 2>&1 && break; sleep 3; done
      docker exec "$DB_NAME" bin/ysqlsh -h "$HOST" -c "CREATE DATABASE church" >/dev/null || die "could not create the database"
      DATABASE_URL="postgresql://yugabyte@$HOST:5433/church"
      ;;
    *) die "engine must be cockroach or yugabyte" ;;
  esac
}

start_object_store() {
  S3_ACCESS_KEY="GK$(rand_hex 12)"
  S3_SECRET_KEY="$(rand_hex 32)"
  docker rm -f "$S3_NAME" >/dev/null 2>&1
  docker run -d --name "$S3_NAME" -p "$S3_PORT:3900" \
    -e GARAGE_RPC_SECRET="$(rand_hex 32)" -e GARAGE_ADMIN_TOKEN="$(rand_hex 16)" -e GARAGE_RPC_PUBLIC_ADDR=127.0.0.1:3901 \
    -v "$PWD/infra/garage/garage.toml.tpl:/etc/garage.toml.tpl:ro" \
    -v "$PWD/infra/garage/garage-render.sh:/usr/local/bin/garage-render.sh:ro" \
    -v "$PWD/infra/garage/garage-entrypoint.sh:/usr/local/bin/garage-entrypoint.sh:ro" \
    -v "$PWD/infra/garage/garage-init.sh:/usr/local/bin/garage-init.sh:ro" \
    --entrypoint sh church-garage /usr/local/bin/garage-entrypoint.sh garage -c /tmp/garage.toml server >/dev/null
  for _ in $(seq 1 30); do docker exec "$S3_NAME" garage -c /tmp/garage.toml status >/dev/null 2>&1 && break; sleep 1; done
  local secret; secret="$(docker inspect "$S3_NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^GARAGE_RPC_SECRET=//p')"
  docker exec -e GARAGE_RPC_SECRET="$secret" -e GARAGE_RPC_PUBLIC_ADDR=127.0.0.1:3901 -e S3_ACCESS_KEY="$S3_ACCESS_KEY" -e S3_SECRET_KEY="$S3_SECRET_KEY" -e S3_BUCKET=church-files \
    "$S3_NAME" sh /usr/local/bin/garage-init.sh >/dev/null || die "could not set up the object store"
}

start_balancer() {
  mkdir -p "$SIM_DIR/lb"
  cat >"$SIM_DIR/lb/Caddyfile" <<CADDY
{
	auto_https off
}
:$LB_PORT {
	reverse_proxy $HOST:8201 $HOST:8202 {
		lb_policy round_robin
		lb_try_duration 5s
		health_uri /healthz
		health_interval 2s
		health_timeout 2s
		health_status 2xx
		header_up Host {host}
	}
}
CADDY
  docker rm -f "$LB_NAME" >/dev/null 2>&1
  docker run -d --name "$LB_NAME" -p "$LB_PORT:$LB_PORT" -v "$SIM_DIR/lb/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.8-alpine >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 120); do
    [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$(url "$1")/healthz")" == 200 ]] && return 0
    sleep 2
  done
  return 1
}

cmd_up() {
  local engine="${1:-cockroach}"
  [[ ! -d "$SIM_DIR/node1" ]] || die "$SIM_DIR already has nodes: run 'tests/cluster/shape-d.sh down' first."
  mkdir -p "$SIM_DIR"
  echo "== the database you run ($engine) and the object store you run (Garage)"
  start_database "$engine"
  start_object_store
  {
    echo "SIM_SHAPE=d"
    echo "SIM_D_DATABASE_URL=$DATABASE_URL"
    echo "SIM_D_S3_ENDPOINT=http://$HOST:$S3_PORT"
    echo "SIM_D_S3_ACCESS_KEY=$S3_ACCESS_KEY"
    echo "SIM_D_S3_SECRET_KEY=$S3_SECRET_KEY"
    echo "ENGINE=$engine"
  } >"$STATE"
  # shellcheck disable=SC1090
  set -a; . "$STATE"; set +a
  echo "== two app nodes, each configured the way INSTALL.md says for shape D"
  $SIM nodeonly 1 2 && $SIM nodeonly 2 2 || die "could not create the nodes"
  echo "== migrate and seed once, then start both nodes"
  $SIM in 1 bash scripts/cluster.sh migrate 2>&1 | grep -E "^\[migrate\]|rror" | tail -3
  $SIM in 1 bash scripts/cluster.sh seed 2>&1 | grep -E "^\[seed\] done|rror" | tail -2
  for n in 1 2; do $SIM in "$n" bash scripts/cluster.sh up >/dev/null 2>&1; done
  for n in 1 2; do wait_healthy "$n" || die "node $n did not become healthy"; done
  echo "== the load balancer"
  start_balancer
  sleep 3
  echo "shape-d: ready. Load balancer $(lb), nodes $(url 1) and $(url 2), database $engine, object store $HOST:$S3_PORT"
}

cmd_down() {
  [[ -f "$STATE" ]] && { set -a; . "$STATE"; set +a; }
  docker rm -f "$LB_NAME" "$S3_NAME" "$DB_NAME" >/dev/null 2>&1
  $SIM down 2>&1 | tail -n 1
  rm -rf "$SIM_DIR/lb" 2>/dev/null
}

run_node() { docker run --rm --network=host -v "$PWD":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp "$@"; }

cmd_test() {
  [[ -f "$STATE" ]] || die "not running: tests/cluster/shape-d.sh up"
  set -a; . "$STATE"; set +a
  local fails=0
  check() { local name="$1"; shift; echo "== $name"; if "$@"; then echo "  -> ok"; else echo "  -> FAILED"; fails=$((fails + 1)); fi; }

  # Any running node will do (one of them is stopped in the failover check).
  reset_user() {
    $SIM in 1 bash scripts/compose.sh --prod exec -T api node dist/scripts/reset-test-user.js >/dev/null 2>&1 \
      || $SIM in 2 bash scripts/compose.sh --prod exec -T api node dist/scripts/reset-test-user.js >/dev/null 2>&1
  }

  # 1. The whole smoke suite through the load balancer: every request may land on either node, so a
  #    sign-in on one and a write on the other is the normal case.
  smoke() { reset_user; local out; out="$(run_node -e BASE="$(lb)" node:20-alpine node tests/smoke/run.mjs 2>&1)"; echo "$out" | grep -E "FAIL|smoke:" | tail -n 12 | sed 's/^/   /'; echo "$out" | grep -q " 0 failed"; }
  check "the smoke suite through the load balancer (requests alternate between the nodes)" smoke

  # 2. The load balancer really spreads: both nodes answer, named in X-Church-Node.
  spread() {
    local seen; seen="$(for _ in $(seq 1 12); do curl -s -D - -o /dev/null "$(lb)/healthz" | tr -d '\r' | sed -n 's/^[Xx]-[Cc]hurch-[Nn]ode: //p'; done | sort | uniq -c)"
    echo "$seen" | sed 's/^/   /'
    [[ "$(echo "$seen" | wc -l)" -eq 2 ]]
  }
  check "both nodes serve through the load balancer" spread

  # 3. What a user sees must not depend on the node.
  crossnode() { run_node -e NODES="$(url 1),$(url 2)" node:20-alpine node tests/cluster/cross-node.mjs 2>&1 | tail -n 9; return "${PIPESTATUS[0]}"; }
  check "read-after-write, sessions, uploads and search across the two nodes" crossnode

  # 4. Backups, restores and the write gate across nodes.
  restore() { reset_user; run_node -e NODES="$(url 1),$(url 2)" -e SCHEDULER=0 node:20-alpine node tests/cluster/backup-restore.mjs 2>&1 | tail -n 15; return "${PIPESTATUS[0]}"; }
  check "backup on one node, compare and restore on the other, undo, upload" restore

  # 5. A node stops: the load balancer takes it out and the site keeps working.
  failover() {
    $SIM in 1 bash scripts/compose.sh --prod stop >/dev/null 2>&1
    sleep 6
    local ok=0 bad=0 node
    for _ in $(seq 1 10); do
      node="$(curl -s -m 5 -D - -o /dev/null "$(lb)/healthz" | tr -d '\r' | sed -n 's/^[Xx]-[Cc]hurch-[Nn]ode: //p')"
      [[ "$node" == "sim-2" ]] && ok=$((ok + 1)) || bad=$((bad + 1))
    done
    echo "   with node 1 stopped: $ok of 10 health checks answered by node 2, $bad otherwise"
    reset_user
    local smoke_ok=1 out
    out="$(run_node -e BASE="$(lb)" node:20-alpine node tests/smoke/run.mjs 2>&1)"
    echo "$out" | grep -E "FAIL|smoke:" | tail -n 6 | sed 's/^/   /'
    echo "$out" | grep -q " 0 failed" || smoke_ok=0
    $SIM in 1 bash scripts/cluster.sh up >/dev/null 2>&1
    wait_healthy 1 || return 1
    sleep 6
    [[ $ok -eq 10 && $smoke_ok -eq 1 ]]
  }
  check "node 1 stops: everything goes through node 2, the smoke suite still passes, and node 1 rejoins" failover

  # 6. The Cluster page's data sees both nodes and the jobs.
  clusterpage() {
    reset_user
    run_node -e NODES="$(url 1)" node:20-alpine node -e '
      const base = process.argv[1];
      (async () => {
        const jar = new Map();
        const call = async (p, init = {}) => { const c = [...jar].map(([k, v]) => `${k}=${v}`).join("; "); const r = await fetch(base + p, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...(c ? { cookie: c } : {}) } }); for (const sc of r.headers.getSetCookie?.() ?? []) { const kv = sc.split(";")[0]; const i = kv.indexOf("="); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); } return r; };
        const { csrfToken } = await (await call("/api/auth/csrf")).json();
        await call("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken, email: "regression-test@local", password: "regression-default-pwd", callbackUrl: base + "/", json: "true" }) });
        await call("/api/v1/me/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newPassword: "regression-smoke-pwd-1" }) });
        const s = await (await call("/api/v1/admin/cluster")).json();
        const live = s.nodes.filter((n) => n.live).map((n) => n.id).sort();
        console.log("   live nodes:", live.join(", "), "| jobs held:", s.jobs.filter((j) => j.held).length, "/", s.jobs.length, "| database:", s.database.label, "| store:", s.store.kind, s.store.ok ? "ok" : "NOT OK", "| problems:", s.problems.map((p) => p.message).join(" ; ") || "none");
        process.exit(live.length === 2 && s.database.ok && s.store.ok && s.problems.filter((p) => p.severity === "error").length === 0 ? 0 : 1);
      })().catch((e) => { console.error(e); process.exit(1); });
    ' "$(url 1)"
  }
  check "the Cluster page sees both nodes, the database and the object store" clusterpage

  # 6b. A node dies for real (killed, no goodbye): the administrators are told, the Cluster page shows it,
  #     and both clear when it returns.
  watch() {
    reset_user
    # Sign the test user in once so the notification lands for an admin (the test user is one).
    docker kill sim2-api-1 >/dev/null 2>&1
    run_node -e NODE="$(url 1)" -e TARGET=sim-2 -e PHASE=down node:20-alpine node tests/cluster/node-watch.mjs || { $SIM in 2 bash scripts/cluster.sh up >/dev/null 2>&1; return 1; }
    $SIM in 2 bash scripts/cluster.sh up >/dev/null 2>&1
    wait_healthy 2 || return 1
    run_node -e NODE="$(url 1)" -e TARGET=sim-2 -e PHASE=up node:20-alpine node tests/cluster/node-watch.mjs
  }
  check "a node is killed: the admins are notified, the Cluster page shows it, and both clear on return" watch

  # 7. The browser suite through the load balancer: pages, Server Actions, static files and WebSockets
  #    served by whichever node the balancer picks, in the same session. Addressed as localhost: the
  #    clipboard API (one spec copies a token) exists only in a secure context, and a bare IP is not one.
  browser() {
    reset_user
    local out
    out="$(docker run --rm --network=host --ipc=host -v "$PWD":/w -w /w/tests/e2e -u "$(id -u):$(id -g)" -e HOME=/tmp -e BASE="http://localhost:$LB_PORT" \
      mcr.microsoft.com/playwright:v1.48.0-jammy npx playwright test --reporter=line 2>&1)"
    echo "$out" | grep -E "passed|failed|flaky|FAIL|\) \[" | tail -n 8 | sed 's/^/   /'
    echo "$out" | grep -qE "[0-9]+ passed" && ! echo "$out" | grep -qE "[0-9]+ failed"
  }
  check "the browser suite (Playwright) through the load balancer" browser

  echo
  [[ $fails -eq 0 ]] && echo "shape-d: all checks passed ($ENGINE)" || { echo "shape-d: $fails check(s) failed ($ENGINE)"; return 1; }
}

case "${1:-}" in
  up) cmd_up "${2:-cockroach}" ;;
  test) cmd_test ;;
  down) cmd_down ;;
  *) sed -n '3,9p' "$0"; exit 2 ;;
esac
