#!/usr/bin/env python3
"""
A node dies in the middle of a restore (tests/cluster/sim.sh up 3 first).

The restore holds a write gate (a lease). If the node doing it vanished and the gate stayed shut, the
whole site would refuse changes for good. This starts a restore on node 2, kills node 2's API while it
is making its safety backup, and checks that:
  - writes through node 1 are refused while the gate is held (so the gate really was shut);
  - they are accepted again within the gate lease's lifetime (about 40 seconds), without anyone doing anything;
  - nothing was half-restored: data changed after the backup is still as it was;
  - the stuck operation is marked failed by the scheduler, not left "running" forever (about 3 minutes).
It restarts node 2 afterwards.   Usage: tests/cluster/restore-node-death.py
"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request, http.cookiejar

HOST = os.environ.get("SIM_HOST") or subprocess.check_output(["hostname", "-I"], text=True).split()[0]
SIM_DIR = os.path.expanduser(os.environ.get("SIM_DIR", "~/church-sim"))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PASSWORD = "regression-smoke-pwd-1"
EMAIL = "regression-test@local"
fails = 0


def url(n): return f"http://{HOST}:{8200 + n}"
def ok(msg): print(f"  ok    {msg}")
def bad(msg):
    global fails
    fails += 1
    print(f"  FAIL  {msg}")


class Node:
    def __init__(self, n):
        self.base = url(n)
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def call(self, method, path, body=None, form=None):
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode(); headers["content-type"] = "application/json"
        if form is not None:
            data = urllib.parse.urlencode(form).encode(); headers["content-type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=30) as r:
                text = r.read().decode()
                return r.status, (json.loads(text) if text.startswith(("{", "[")) else text)
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            try: return e.code, json.loads(text)
            except Exception: return e.code, text
        except Exception as e:
            return 0, str(e)

    def sign_in(self):
        _, csrf = self.call("GET", "/api/auth/csrf")
        self.call("POST", "/api/auth/callback/credentials", form={"csrfToken": csrf["csrfToken"], "email": EMAIL, "password": PASSWORD, "callbackUrl": self.base + "/", "json": "true"})
        return any("session-token" in c.name for c in self.jar)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def sim(n, *cmd):
    return subprocess.run(["bash", os.path.join(ROOT, "tests/cluster/sim.sh"), "in", str(n), *cmd], capture_output=True, text=True, cwd=ROOT)


# The test user must exist with the usual password (the cluster tests share it).
sim(1, "bash", "scripts/compose.sh", "--prod", "exec", "-T", "api", "node", "dist/scripts/reset-test-user.js")
n1, n2 = Node(1), Node(2)
for n in (n1, n2):
    if not n.sign_in():
        # Fresh test user: change the default password first.
        n.call("POST", "/api/auth/callback/credentials", form={"csrfToken": n.call("GET", "/api/auth/csrf")[1]["csrfToken"], "email": EMAIL, "password": "regression-default-pwd", "callbackUrl": n.base + "/", "json": "true"})
        n.call("POST", "/api/v1/me/change-password", body={"newPassword": PASSWORD})
        if not n.sign_in(): sys.exit("could not sign in")

def wait_op(node, op_id, seconds=60, until=lambda op: op["status"] != "running"):
    end = time.time() + seconds
    while time.time() < end:
        _, op = node.call("GET", f"/api/v1/admin/backups/operations/{op_id}")
        if isinstance(op, dict) and until(op): return op
        time.sleep(0.5)
    return None

print("== a note, a backup, then a change after it")
_, note = n1.call("POST", "/api/v1/notes", body={"title": "death test original", "body": ""})
_, started = n1.call("POST", "/api/v1/admin/backups", body={"name": "death-test", "includeFiles": True})
op = wait_op(n1, started["operationId"], 120)
backup_id = op["backupId"] if op and op["status"] == "succeeded" else None
if not backup_id: sys.exit(f"backup did not finish: {op}")
n1.call("PATCH", f"/api/v1/notes/{note['id']}", body={"title": "death test CHANGED AFTER"})
ok("backup made, note edited afterwards")

print("== start the restore on node 2, kill node 2's API while it holds the gate and has not touched the data")
code, started = n2.call("POST", f"/api/v1/admin/backups/{backup_id}/restore", body={"confirm": "RESTORE", "safetyBackup": True})
if code != 202: sys.exit(f"restore did not start: {code} {started}")
restore_op = started["operationId"]
# "Pausing changes": the gate has just been taken and a few seconds of waiting for in-flight writes follow,
# long before the database step. Kill the container itself (no script in the way) the moment that shows.
seen = wait_op(n2, restore_op, 60, until=lambda o: (o.get("phase") or "") == "Pausing changes" or o["status"] != "running")
if not seen or seen["status"] != "running": sys.exit(f"the restore was not caught pausing changes: {seen}")
killed_at = time.time()
subprocess.run(["docker", "kill", "sim2-api-1"], capture_output=True)
ok(f"killed node 2's api during '{seen.get('phase')}'")

print("== the gate stays shut for a moment, then opens by itself")
refused = False
reopened_after = None
deadline = killed_at + 100
while time.time() < deadline:
    code, _ = n1.call("POST", "/api/v1/notes", body={"title": "death probe", "body": ""})
    if code == 503: refused = True
    if code in (200, 201):
        reopened_after = time.time() - killed_at
        break
    time.sleep(2)
if refused: ok("writes through node 1 were refused while the gate was held")
else: bad("no write was refused: the gate was never seen shut (the restore was too quick, or the gate is not working)")
if reopened_after is not None and reopened_after < 70: ok(f"writes were accepted again {reopened_after:.0f} s after the node died, with nobody touching anything")
else: bad(f"writes were not accepted again within 70 s (took {reopened_after})")

print("== nothing was half-restored")
_, notes = n1.call("GET", "/api/v1/notes")
title = next((x["title"] for x in notes if x["id"] == note["id"]), None)
if title == "death test CHANGED AFTER": ok("the note edited after the backup is still as edited: the data was not touched")
else: bad(f"the note reads '{title}': a partial restore happened")

print("== the abandoned operation is marked failed (the scheduler does this, within about three minutes)")
op = wait_op(n1, restore_op, 260)
if op and op["status"] == "failed": ok(f"operation failed with: {op.get('error')}")
else: bad(f"operation is '{op and op['status']}', not failed")

print("== node 2 comes back")
sim(2, "bash", "scripts/cluster.sh", "up")
for _ in range(60):
    code, _ = n2.call("GET", "/api/v1/readyz")
    if code == 200: break
    time.sleep(2)
ok("node 2 is back") if code == 200 else bad("node 2 did not come back")

# Leave nothing behind.
n1.call("DELETE", f"/api/v1/notes/{note['id']}")
_, lst = n1.call("GET", "/api/v1/admin/backups")
for b in lst if isinstance(lst, list) else []:
    if b["name"] == "death-test" or b["name"].startswith('Before restoring "death-test"') or b["status"] == "running":
        n1.call("DELETE", f"/api/v1/admin/backups/{b['id']}")
for x in (notes if isinstance(notes, list) else []):
    if x["title"] == "death probe": n1.call("DELETE", f"/api/v1/notes/{x['id']}")

print(f"\nrestore-node-death: {'all checks passed' if fails == 0 else str(fails) + ' check(s) failed'}")
sys.exit(1 if fails else 0)
