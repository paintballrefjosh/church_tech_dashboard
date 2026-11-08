"""`signage-ctl`: the only program the dashboard's key runs once it is restricted (docs/signage.md section 7).

The command comes from `SSH_ORIGINAL_COMMAND` (a forced-command key) or from argv. It is split on spaces, never given to
a shell, and must be one of the commands below with arguments of the expected shape. Output is one JSON object on
stdout; exit 0 = ok, 2 = refused, 1 = failed (the JSON then has "error"). Commands that need root re-run themselves
through `sudo -n` (the sudoers rule names exactly this program).
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Dict, List, NoReturn

from . import apply as ap
from . import manifest as mf
from . import media, osupdate, paths, status, tv, version
from .util import read_json, run, write_json

SHA = re.compile(r"^[0-9a-f]{64}$")
NUM = re.compile(r"^\d{1,12}$")
VERSION_RE = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,4}$")
TOKEN = re.compile(r"^[0-9a-f]{16}$")
CODE = re.compile(r"^\d{3}$")
B64 = re.compile(r"^[A-Za-z0-9_-]{0,400}={0,2}$")
SSHCONN = re.compile(r"^[0-9a-fA-F.:]{3,45} \d{1,5} [0-9a-fA-F.:]{3,45} \d{1,5}$")
MAX_STDIN = {"manifest-put": mf.MAX_BYTES, "apply": 64 * 1024, "agent-put": 32 * 1024 * 1024}
CONFIG_KEYS = {"hwdec": {"auto-safe", "no", "drm"}}

# Commands a remote caller may run, and whether each needs root.
COMMANDS = {
    "hello": False,
    "status": True,
    "media-list": True,
    "media-put": True,
    "manifest-put": True,
    "identify": True,
    "screenshot": True,
    "logs": True,
    "tv": True,
    "restart-player": True,
    "restart-agent": True,
    "reboot": True,
    "diag": True,
    "config": True,
    "agent-put": True,
    "apply": True,
    "confirm": True,
    "os-update": True,
}
# Only from argv (the agent itself, the timed undo), never from SSH_ORIGINAL_COMMAND.
INTERNAL = {"revert-after": True, "rollback-check": True, "os-update-run": True, "agent-install": True}


class Refused(Exception):
    pass


def out(obj: Dict, code: int = 0) -> NoReturn:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def read_stdin(cmd: str) -> bytes:
    cap = MAX_STDIN.get(cmd, 0)
    data = sys.stdin.buffer.read(cap + 1)
    if len(data) > cap:
        raise Refused(f"{cmd}: input over {cap} bytes")
    return data


def spawn_detached(args: List[str]) -> None:
    ctl = os.path.join(paths.CURRENT, "bin", "signage-ctl")
    subprocess.Popen([sys.executable, ctl, *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def need(args: List[str], n: int, usage: str) -> None:
    if len(args) != n:
        raise Refused(f"usage: {usage}")


# ------------------------------------------------------------------ commands


def c_hello(args: List[str], conn: str) -> Dict:
    return {"agentVersion": version(), "user": _user(), "sshConnection": conn or None, "macs": status.macs(), "model": ap.model(), "os": ap.os_release().get("PRETTY_NAME", "")}


def c_identify(args: List[str], conn: str) -> Dict:
    if args == ["off"]:
        try:
            os.unlink(paths.IDENTIFY)
        except FileNotFoundError:
            pass
        return {"identify": None}
    if len(args) not in (2, 3) or not CODE.match(args[0]) or not NUM.match(args[1]) or not 5 <= int(args[1]) <= 600 or (len(args) == 3 and not B64.match(args[2])):
        raise Refused("usage: identify <3 digits> <seconds> [label in base64url] | identify off")
    label = ""
    if len(args) == 3:
        label = base64.urlsafe_b64decode(args[2] + "=" * (-len(args[2]) % 4)).decode("utf-8", "replace")[:80]
    until = time.time() + int(args[1])
    os.makedirs(paths.RUN, exist_ok=True)
    write_json(paths.IDENTIFY, {"code": args[0], "label": label, "untilTs": until, "until": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until))})
    return {"identify": args[0], "until": until}


def c_media_put(args: List[str], conn: str) -> Dict:
    need(args, 3, "media-put <sha256> <offset> <size>")
    if not SHA.match(args[0]) or not NUM.match(args[1]) or not NUM.match(args[2]):
        raise Refused("media-put: bad arguments")
    try:
        return media.put(args[0], int(args[1]), int(args[2]), sys.stdin.buffer)
    except media.MediaError as e:
        raise Refused(str(e)) from None


def c_manifest_put(args: List[str], conn: str) -> Dict:
    raw = read_stdin("manifest-put")
    try:
        m = mf.validate(raw)
    except mf.ManifestError as e:
        raise Refused(f"manifest refused: {e}") from None
    current = mf.load(paths.MANIFEST)
    if current and current.get("screenId") == m["screenId"] and current["version"] > m["version"]:
        return {"manifestVersion": current["version"], "kept": "newer"}
    os.makedirs(paths.DATA, exist_ok=True)
    from .util import write_file

    write_file(paths.MANIFEST, raw, 0o644, persist=False)
    have = set(media.listing()["media"].keys())
    return {"manifestVersion": m["version"], "missingMedia": [s for s in m["media"] if s not in have]}


def c_screenshot(args: List[str], conn: str) -> Dict:
    from .player import Mpv

    path = os.path.join(paths.RUN, "mpv", "shot.jpg")
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    if not Mpv().screenshot(path):
        raise Refused("the player did not take a picture (is anything playing?)")
    with open(path, "rb") as f:
        data = f.read(4 * 1024 * 1024)
    os.unlink(path)
    return {"jpegB64": base64.b64encode(data).decode()}


def c_logs(args: List[str], conn: str) -> Dict:
    need(args, 1, "logs <lines>")
    if not NUM.match(args[0]):
        raise Refused("logs: bad number")
    n = max(1, min(2000, int(args[0])))
    code, o, e = run(["journalctl", "-u", "signage-agent", "-n", str(n), "--no-pager", "-o", "short-iso"], timeout=20)
    return {"lines": (o or e).splitlines()[-n:]}


def c_tv(args: List[str], conn: str) -> Dict:
    m = mf.load(paths.MANIFEST)
    block = (m or {}).get("tv") or {}
    try:
        drv = tv.driver(block)
        if drv is None:
            raise Refused("this screen's TV is not controlled (set TV control on the screen)")
        if args == ["state"]:
            return {"tv": drv.info()}
        if len(args) == 2 and args[0] == "power" and args[1] in ("on", "off"):
            drv.power(args[1])
            return {"tv": "power " + args[1]}
        if len(args) == 2 and args[0] == "input" and args[1] in tv.INPUTS:
            drv.input(args[1])
            return {"tv": "input " + args[1]}
    except tv.TvError as e:
        return {"error": str(e)}
    raise Refused("usage: tv state | tv power on|off | tv input <InputHDMI1..4|InputAV1|InputTuner>")


def c_restart_player(args: List[str], conn: str) -> Dict:
    code, _, err = run(["systemctl", "kill", "-s", "USR1", "signage-agent.service"])
    return {"restarted": code == 0, "error": err.strip() or None}


def c_restart_agent(args: List[str], conn: str) -> Dict:
    code, _, err = run(["systemctl", "restart", "--no-block", "signage-agent.service"])
    return {"restarted": code == 0, "error": err.strip() or None}


def c_reboot(args: List[str], conn: str) -> Dict:
    subprocess.Popen(["/bin/sh", "-c", "sleep 2; systemctl reboot"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"rebooting": True}


def c_diag(args: List[str], conn: str) -> Dict:
    def cmd(*a: str) -> str:
        code, o, e = run(list(a), timeout=15)
        return (o + e).strip()[-4000:]

    return {
        "status": status.collect(full=False),
        "throttled": cmd("vcgencmd", "get_throttled"),
        "temp": cmd("vcgencmd", "measure_temp"),
        "df": cmd("df", "-h", "/", paths.DATA),
        "free": cmd("free", "-m"),
        "ip": cmd("ip", "-brief", "address"),
        "wifi": cmd("iw", "dev", "wlan0", "link"),
        "time": cmd("timedatectl"),
        "agent": cmd("systemctl", "status", "--no-pager", "-n", "0", "signage-agent.service"),
        "cec": cmd("cec-ctl", "-d", "/dev/cec0", "--list-devices"),
        "displays": cmd("sh", "-c", "for d in /sys/class/drm/*HDMI*; do echo $d $(cat $d/status) $(head -n1 $d/modes); done"),
        "journal": cmd("journalctl", "-u", "signage-agent", "-n", "50", "--no-pager"),
    }


def c_config(args: List[str], conn: str) -> Dict:
    cfg = read_json(paths.LOCAL_CONFIG, {}) or {}
    if args == ["get"]:
        return {"config": cfg}
    if len(args) == 3 and args[0] == "set" and args[1] in CONFIG_KEYS and args[2] in CONFIG_KEYS[args[1]]:
        cfg[args[1]] = args[2]
        write_json(paths.LOCAL_CONFIG, cfg)
        return {"config": cfg}
    raise Refused("usage: config get | config set hwdec auto-safe|no|drm")


def c_apply(args: List[str], conn: str) -> Dict:
    raw = read_stdin("apply")
    try:
        return ap.apply(raw)
    except ap.ApplyError as e:
        return {"ok": False, "error": str(e)}
    except ap.render.ConfigError as e:
        raise Refused(f"bad settings: {e}") from None


def c_confirm(args: List[str], conn: str) -> Dict:
    need(args, 1, "confirm <token>")
    if not TOKEN.match(args[0]):
        raise Refused("confirm: bad token")
    try:
        r = ap.confirm(args[0], conn)
    except ap.ApplyError as e:
        return {"confirmed": False, "error": str(e)}
    return r


def c_os_update(args: List[str], conn: str) -> Dict:
    s = osupdate.state()
    if s.get("phase"):
        return {"started": False, "state": s.get("state")}
    spawn_detached(["os-update-run"])
    return {"started": True}


def c_agent_put(args: List[str], conn: str) -> Dict:
    need(args, 2, "agent-put <version> <sha256>")
    if not VERSION_RE.match(args[0]) or not SHA.match(args[1]):
        raise Refused("agent-put: bad arguments")
    data = read_stdin("agent-put")
    import hashlib

    if hashlib.sha256(data).hexdigest() != args[1]:
        raise Refused("the release does not match its sha256")
    tmp = tempfile.mkdtemp(prefix="signage-agent-")
    try:
        tgz = os.path.join(tmp, "a.tgz")
        with open(tgz, "wb") as f:
            f.write(data)
        src = os.path.join(tmp, "x")
        extract(tgz, src)
        return install(src, args[0])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def extract(tgz: str, dest: str) -> None:
    os.makedirs(dest)
    with tarfile.open(tgz, "r:gz") as t:
        for m in t.getmembers():
            name = m.name
            if name.startswith("/") or ".." in name.split("/") or not (m.isfile() or m.isdir()):
                raise Refused(f"the release holds an unsafe entry: {name}")
        t.extractall(dest, filter="data")


def install(src: str, ver: str) -> Dict:
    """Put an extracted release at /opt/signage/agent/<version>, switch `current` to it and restart the agent. A
    previous version is kept; if the new agent is not healthy within 120 s the watchdog switches back."""
    try:
        with open(os.path.join(src, "VERSION"), encoding="utf-8") as f:
            found = f.read().strip()
    except OSError:
        raise Refused("the release has no VERSION file") from None
    if found != ver:
        raise Refused(f"the release says it is {found}, not {ver}")
    os.makedirs(paths.AGENTS, exist_ok=True)
    target = os.path.join(paths.AGENTS, ver)
    if os.path.realpath(paths.CURRENT) != os.path.realpath(target):
        if os.path.exists(target):
            shutil.rmtree(target)
        shutil.copytree(src, target)
    os.chmod(os.path.join(target, "bin", "signage-ctl"), 0o755)
    os.chmod(os.path.join(target, "bin", "signage-agent"), 0o755)
    prev = os.path.realpath(paths.CURRENT) if os.path.islink(paths.CURRENT) else None
    if prev == os.path.realpath(target):
        prev = None
    _swap_link(paths.CURRENT, target)
    if prev:
        _swap_link(paths.PREVIOUS, prev)
    os.makedirs(os.path.dirname(paths.CTL_LINK), exist_ok=True)
    _swap_link(paths.CTL_LINK, os.path.join(paths.CURRENT, "bin", "signage-ctl"))
    for d in (paths.DATA, paths.MEDIA, paths.PARTIAL):
        os.makedirs(d, exist_ok=True)
    restarted = False
    if not ap.simulated() and shutil.which("systemctl"):
        units = os.path.join(target, "systemd")
        for u in os.listdir(units):
            from .util import write_file

            with open(os.path.join(units, u), encoding="utf-8") as f:
                write_file(os.path.join(paths.SYSTEMD, u), f.read())
        run(["systemctl", "daemon-reload"])
        code, _, _ = run(["systemctl", "is-enabled", "signage-agent.service"])
        if code == 0:
            run(["systemctl", "restart", "--no-block", "signage-agent.service"])
            restarted = True
    if prev and restarted:
        spawn_detached(["rollback-check", os.path.basename(prev), "120"])
    # Keep the current and previous versions only.
    keep = {os.path.realpath(paths.CURRENT), os.path.realpath(paths.PREVIOUS) if os.path.islink(paths.PREVIOUS) else ""}
    for name in os.listdir(paths.AGENTS):
        full = os.path.join(paths.AGENTS, name)
        if VERSION_RE.match(name) and os.path.realpath(full) not in keep:
            shutil.rmtree(full, ignore_errors=True)
    return {"installed": ver, "previous": os.path.basename(prev) if prev else None, "restarted": restarted}


def _swap_link(link: str, target: str) -> None:
    tmp = f"{link}.new"
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    os.symlink(target, tmp)
    os.replace(tmp, link)


def c_agent_install(args: List[str], conn: str) -> Dict:
    need(args, 2, "agent-install <dir> <version>")
    if not VERSION_RE.match(args[1]):
        raise Refused("bad version")
    return install(args[0], args[1])


def c_revert_after(args: List[str], conn: str) -> Dict:
    need(args, 2, "revert-after <token> <seconds>")
    time.sleep(int(args[1]))
    return {"reverted": ap.revert(args[0], lambda _m: None)}


def c_rollback_check(args: List[str], conn: str) -> Dict:
    need(args, 2, "rollback-check <previous version> <seconds>")
    started = time.time()
    time.sleep(int(args[1]))
    try:
        healthy = os.stat(paths.HEALTHY).st_mtime > started
    except OSError:
        healthy = False
    if healthy:
        return {"rolledBack": False}
    prev = os.path.join(paths.AGENTS, args[0])
    if not os.path.isdir(prev):
        return {"rolledBack": False}
    _swap_link(paths.CURRENT, prev)
    run(["systemctl", "restart", "--no-block", "signage-agent.service"])
    return {"rolledBack": True}


def c_os_update_run(args: List[str], conn: str) -> Dict:
    return osupdate.start()


HANDLERS = {
    "hello": c_hello,
    "status": lambda a, c: status.collect(full=True),
    "media-list": lambda a, c: media.listing(),
    "media-put": c_media_put,
    "manifest-put": c_manifest_put,
    "identify": c_identify,
    "screenshot": c_screenshot,
    "logs": c_logs,
    "tv": c_tv,
    "restart-player": c_restart_player,
    "restart-agent": c_restart_agent,
    "reboot": c_reboot,
    "diag": c_diag,
    "config": c_config,
    "agent-put": c_agent_put,
    "apply": c_apply,
    "confirm": c_confirm,
    "os-update": c_os_update,
    "revert-after": c_revert_after,
    "rollback-check": c_rollback_check,
    "os-update-run": c_os_update_run,
    "agent-install": c_agent_install,
}


def _user() -> str:
    import pwd

    try:
        return pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        return str(os.getuid())


def parse(argv: List[str], env: Dict[str, str]):
    """(command, args, from_ssh). A forced-command key gives the client's command in SSH_ORIGINAL_COMMAND."""
    original = env.get("SSH_ORIGINAL_COMMAND")
    if original is not None and not argv:
        words = original.split()
        if words and words[0] in ("signage-ctl", paths.CTL_LINK):
            words = words[1:]
        if any(not re.match(r"^[A-Za-z0-9._:=/+-]{1,500}$", w) for w in words):
            raise Refused("unexpected characters in the command")
        return (words[0] if words else "hello"), words[1:], True
    return (argv[0] if argv else "hello"), argv[1:], False


def main(argv: List[str] = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    conn = os.environ.get("SSH_CONNECTION", "")
    # Passed on through sudo, which drops the environment.
    if argv and argv[0].startswith("--ssh-connection="):
        conn = argv.pop(0).split("=", 1)[1].replace("_", " ")
    if conn and not SSHCONN.match(conn):
        conn = ""
    try:
        cmd, args, from_ssh = parse(argv, os.environ)
        allowed = dict(COMMANDS) if from_ssh else {**COMMANDS, **INTERNAL}
        if cmd not in allowed:
            raise Refused(f"unknown command: {cmd}")
        if allowed[cmd] and os.geteuid() != 0 and not paths.ROOT:
            sudo = ["/usr/bin/sudo", "-n", paths.CTL_LINK]
            if conn:
                sudo.append("--ssh-connection=" + conn.replace(" ", "_"))
            os.execv(sudo[0], sudo + [cmd] + args)
        result = HANDLERS[cmd](args, conn)
    except Refused as e:
        out({"error": str(e), "refused": True}, 2)
    except Exception as e:  # report, never a traceback on the dashboard's screen
        out({"error": f"{type(e).__name__}: {e}"[:1000]}, 1)
    out(result, 1 if isinstance(result, dict) and result.get("error") else 0)
