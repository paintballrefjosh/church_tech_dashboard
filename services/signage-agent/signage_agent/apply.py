"""`signage-ctl apply`: set the Pi up as the dashboard's Signage settings say (docs/signage.md sections 3 and 6).

Every step is idempotent (it checks first and says "already done"), so "Apply again" is safe and is how a changed setting
reaches a Pi. Progress goes to stderr as `@@step <name>` and plain lines; the result is JSON on stdout.

**Never lock the dashboard out.** The SSH drop-in, authorized_keys and the firewall are changed with the old versions kept
and a timed undo started (`revert-after`, 120 s). The dashboard then logs in a SECOND time with its key and the new rules
and runs `signage-ctl confirm <token>`, which cancels the undo. No confirm = everything is put back.
"""

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from typing import Callable, Dict, List

from . import paths, render
from .util import have, overlay_active, read_json, remove_file, run, write_file, write_json

PACKAGES = ["mpv", "v4l-utils", "iw", "nftables", "python3"]
SUPPORTED_CODENAMES = ["trixie"]
REVERT_AFTER_S = 120
UNITS = ["signage-agent.service", "signage-data.service"]


class ApplyError(Exception):
    pass


class Log:
    def __init__(self) -> None:
        self.lines: List[str] = []

    def step(self, name: str) -> None:
        print(f"@@step {name}", file=sys.stderr, flush=True)

    def __call__(self, msg: str) -> None:
        self.lines.append(msg)
        print(msg, file=sys.stderr, flush=True)


def simulated() -> bool:
    """The test container (tests/signage/fake-pi): no Raspberry Pi hardware, no systemd. Hardware steps say so and pass."""
    return os.path.exists(paths.SIMULATED)


def os_release() -> Dict[str, str]:
    out: Dict[str, str] = {}
    try:
        with open(paths.p("/etc/os-release"), encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    out[k] = v.strip('"')
    except OSError:
        pass
    return out


def model() -> str:
    for p in ("/proc/device-tree/model", "/sys/firmware/devicetree/base/model"):
        try:
            with open(paths.p(p), "rb") as f:
                return f.read().rstrip(b"\0").decode("utf-8", "replace").strip()
        except OSError:
            continue
    return ""


def check(log: Log) -> Dict[str, object]:
    log.step("check")
    m = model()
    rel = os_release()
    arch = os.uname().machine
    facts = {"model": m, "os": rel.get("PRETTY_NAME", ""), "codename": rel.get("VERSION_CODENAME", ""), "arch": arch}
    if not simulated() and not m.startswith("Raspberry Pi"):
        raise ApplyError(f"This is not a Raspberry Pi ({m or 'no model reported'}).")
    if not any(m.startswith(f"Raspberry Pi {x}") for x in ("3 Model B Plus", "4", "5", "400", "500")) and not simulated():
        log(f"warning: {m} is not one of the tested models (3B+, 4, 5).")
    if rel.get("VERSION_CODENAME") not in SUPPORTED_CODENAMES:
        raise ApplyError(f"{facts['os'] or 'This OS'} is not supported: flash Raspberry Pi OS Lite 64-bit ({', '.join(SUPPORTED_CODENAMES)}).")
    if arch != "aarch64" and not simulated():
        raise ApplyError(f"The OS is {arch}: flash the 64-bit Raspberry Pi OS Lite.")
    free_mb = shutil.disk_usage(paths.p("/")).free // 1048576
    if free_mb < 1024:
        raise ApplyError(f"Only {free_mb} MB free on the SD card; at least 1 GB is needed.")
    log(f"{m or 'simulated Pi'}, {facts['os']}, {arch}, {free_mb} MB free")
    return facts


def packages(log: Log) -> None:
    log.step("packages")
    code, out, _ = run(["dpkg-query", "-W", "-f=${Package} ${Status}\n"] + PACKAGES)
    installed = {line.split()[0] for line in out.splitlines() if line.endswith("install ok installed")}
    missing = [p for p in PACKAGES if p not in installed]
    if not missing:
        log("packages already installed")
        return
    log(f"installing {' '.join(missing)}")
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive", "LANG": "C.UTF-8"}
    code, out, err = run(["apt-get", "update"], timeout=600, env=env)
    if code != 0:
        raise ApplyError(f"apt-get update failed (can the Pi reach the package mirrors?): {err.strip()[-400:]}")
    code, out, err = run(["apt-get", "install", "-y", "--no-install-recommends"] + missing, timeout=1800, env=env)
    if code != 0:
        raise ApplyError(f"apt-get install failed: {err.strip()[-600:]}")
    log("packages installed")


def ensure_user(name: str, log: Log, groups: List[str], system: bool) -> None:
    if name not in _users():
        args = ["useradd", "--create-home" if not system else "--no-create-home", "--shell", "/bin/bash" if not system else "/usr/sbin/nologin"]
        if system:
            args.append("--system")
        code, _, err = run(args + [name])
        if code != 0:
            raise ApplyError(f"could not create the {name} account: {err.strip()}")
        log(f"created the {name} account")
    wanted = [g for g in groups if _group_exists(g)]
    if wanted:
        run(["usermod", "-a", "-G", ",".join(wanted), name])


def _users() -> List[str]:
    from .util import users

    return users()


def _group_exists(g: str) -> bool:
    try:
        with open(paths.p("/etc/group"), encoding="utf-8") as f:
            return any(line.split(":")[0] == g for line in f)
    except OSError:
        return False


def accounts(c: Dict, log: Log) -> None:
    log.step("accounts")
    login = render.login_user(c)
    if c["loginAccount"] == "dedicated":
        ensure_user(paths.DEDICATED_USER, log, [], system=False)
        # No password at all ("*": nothing matches it), so the dashboard's key is the only way in. Not "passwd -l": sshd
        # refuses even key logins to a LOCKED account when PAM is off.
        run(["usermod", "-p", "*", paths.DEDICATED_USER])
    ensure_user(paths.PLAYER_USER, log, ["video", "render", "audio", "input"], system=True)
    if write_file(paths.SUDOERS, render.sudoers(login), 0o440):
        code, _, err = run(["visudo", "-cf", paths.SUDOERS])
        if code != 0:
            remove_file(paths.SUDOERS)
            raise ApplyError(f"the sudoers rule did not check: {err.strip()}")
        log(f"{login} may run signage-ctl as root")
    for d in (paths.DATA, paths.MEDIA, paths.PARTIAL):
        os.makedirs(d, exist_ok=True)
    os.chmod(paths.DATA, 0o755)


def system(c: Dict, log: Log) -> bool:
    """Host name, time zone, NTP, console, HDMI, Wi-Fi power saving. Returns whether a reboot is needed."""
    log.step("system")
    reboot = False
    if c["hostname"]:
        if write_file(paths.p("/etc/hostname"), c["hostname"] + "\n"):
            run(["hostname", c["hostname"]])
            hosts = _read(paths.p("/etc/hosts"))
            lines = [ln for ln in hosts.splitlines() if not ln.startswith("127.0.1.1")]
            write_file(paths.p("/etc/hosts"), "\n".join(lines + [f"127.0.1.1\t{c['hostname']}"]) + "\n")
            log(f"host name set to {c['hostname']}")
    zone = paths.p(f"/usr/share/zoneinfo/{c['timezone']}")
    if os.path.exists(zone):
        link = paths.p("/etc/localtime")
        if not os.path.islink(link) or os.readlink(link) != zone:
            try:
                os.unlink(link)
            except FileNotFoundError:
                pass
            os.symlink(zone, link)
            write_file(paths.p("/etc/timezone"), c["timezone"] + "\n")
            log(f"time zone set to {c['timezone']}")
    else:
        log(f"warning: time zone {c['timezone']} is not known here; left as it is")
    ntp = f"[Time]\nNTP={c['ntpServer']}\n" if c["ntpServer"] else "[Time]\n"
    if write_file(paths.p("/etc/systemd/timesyncd.conf.d/church-signage.conf"), ntp):
        run(["systemctl", "restart", "systemd-timesyncd"])
        log(f"time server: {c['ntpServer'] or 'the default pool'}")
    nm = "[connection]\nwifi.powersave = 2\n"
    if os.path.isdir(paths.p("/etc/NetworkManager")) and write_file(paths.p("/etc/NetworkManager/conf.d/church-signage.conf"), nm):
        log("Wi-Fi power saving off (after the next reboot)")
    cmdline = paths.p("/boot/firmware/cmdline.txt")
    if os.path.exists(cmdline):
        args = _read(cmdline).split()
        want = {"consoleblank": "0", "vt.global_cursor_default": "0", "quiet": None}
        changed = False
        for k, v in want.items():
            token = k if v is None else f"{k}={v}"
            args = [a for a in args if not (a == k or a.startswith(k + "="))] + [token]
            changed = True
        if not any(a.startswith("video=HDMI-A-1:") for a in args):
            # Drive HDMI even when the TV was off at boot (no hot-plug), at the v1 resolution.
            args.append("video=HDMI-A-1:1920x1080@60D")
        new = " ".join(args) + "\n"
        if changed and write_file(cmdline, new):
            reboot = True
            log("boot options: no console blanking, HDMI forced on at 1920x1080")
    elif not simulated():
        log("warning: /boot/firmware/cmdline.txt not found; boot options not changed")
    if have("systemctl") and not simulated():
        code, out, _ = run(["systemctl", "is-enabled", "getty@tty1.service"])
        if out.strip() != "masked":
            run(["systemctl", "mask", "getty@tty1.service"])
            log("no login prompt on the TV (tty1)")
            reboot = True
        if have("raspi-config"):
            run(["raspi-config", "nonint", "do_boot_behaviour", "B1"], timeout=120)
    return reboot


def agent_units(log: Log) -> None:
    log.step("agent")
    src = os.path.join(paths.CURRENT, "systemd")
    changed = False
    for unit in UNITS:
        try:
            with open(os.path.join(src, unit), encoding="utf-8") as f:
                body = f.read()
        except OSError:
            continue
        changed |= write_file(os.path.join(paths.SYSTEMD, unit), body)
    if simulated() or not have("systemctl"):
        log("agent installed (no systemd here: not started)")
        return
    if changed:
        run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", *UNITS])
    code, _, err = run(["systemctl", "restart", "signage-agent.service"])
    log("agent started" if code == 0 else f"warning: the agent did not start: {err.strip()}")


def lockdown(c: Dict, log: Log) -> Dict[str, object]:
    """SSH and firewall, with a timed undo. Returns {"token", "changed"} (token None when nothing changed)."""
    log.step("lockdown")
    login = render.login_user(c)
    home = _home(login)
    ak = os.path.join(home, ".ssh", "authorized_keys")
    targets = {paths.SSHD_DROPIN: render.sshd_dropin(c), ak: render.authorized_keys(c)}
    if c["firewall"]:
        targets[paths.NFT_FILE] = render.nft_rules(c)
    backups: Dict[str, object] = {}
    for path, body in targets.items():
        old = _read_or_none(path)
        if old != body:
            backups[path] = old
    fw_off = not c["firewall"] and os.path.exists(paths.NFT_FILE)
    if fw_off:
        backups[paths.NFT_FILE] = _read_or_none(paths.NFT_FILE)
    if not backups:
        log("SSH and firewall already as wanted")
        return {"token": None, "changed": False}
    token = secrets.token_hex(8)
    os.makedirs(paths.PENDING, exist_ok=True)
    write_json(os.path.join(paths.PENDING, f"{token}.json"), {"files": backups, "login": login, "at": time.time(), "config": c}, 0o600)
    try:
        os.makedirs(os.path.join(home, ".ssh"), exist_ok=True)
        os.chmod(os.path.join(home, ".ssh"), 0o700)
        write_file(ak, render.authorized_keys(c), 0o600)
        _chown(login, os.path.join(home, ".ssh"))
        _chown(login, ak)
        write_file(paths.SSHD_DROPIN, render.sshd_dropin(c))
        code, _, err = run(["sshd", "-t"])
        if code != 0:
            raise ApplyError(f"sshd refused the new settings: {err.strip()}")
        _reload_sshd()
        if c["firewall"]:
            write_file(paths.NFT_FILE, render.nft_rules(c))
            _firewall_load(log)
        elif fw_off:
            remove_file(paths.NFT_FILE)
            run(["nft", "delete", "table", "inet", "church_signage"])
            log("firewall removed")
    except Exception:
        revert(token, log)
        raise
    _spawn_revert(token)
    log(f"SSH settings applied; they are undone in {REVERT_AFTER_S} s unless the dashboard logs in again")
    return {"token": token, "changed": True}


def _firewall_load(log: Log) -> None:
    run(["nft", "delete", "table", "inet", "church_signage"])
    code, _, err = run(["nft", "-f", paths.NFT_FILE])
    if code != 0:
        raise ApplyError(f"the firewall rules did not load: {err.strip()}")
    unit = "[Unit]\nDescription=Church signage firewall\nAfter=network-pre.target\n\n[Service]\nType=oneshot\nExecStart=/usr/sbin/nft -f /etc/church-signage/firewall.nft\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n"
    if write_file(os.path.join(paths.SYSTEMD, "signage-firewall.service"), unit) and have("systemctl") and not simulated():
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "signage-firewall.service"])
    log("firewall loaded (SSH only from the dashboard)")


def _reload_sshd() -> None:
    if have("systemctl") and not simulated():
        code, _, _ = run(["systemctl", "reload", "ssh"])
        if code == 0:
            return
    pid = _read(paths.p("/run/sshd.pid")).strip()
    if pid.isdigit():
        os.kill(int(pid), 1)


def _spawn_revert(token: str) -> None:
    ctl = os.path.join(paths.CURRENT, "bin", "signage-ctl")
    subprocess.Popen(
        [sys.executable, ctl, "revert-after", token, str(REVERT_AFTER_S)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


def revert(token: str, log: Callable[[str], None] = print) -> bool:
    """Put back what `lockdown` changed (the timed undo, or a failure). False when there is nothing to undo."""
    pending = os.path.join(paths.PENDING, f"{token}.json")
    state = read_json(pending)
    if not state:
        return False
    for path, old in state["files"].items():
        if old is None:
            remove_file(path)
        else:
            write_file(path, old, 0o600 if path.endswith("authorized_keys") else 0o644)
    _reload_sshd()
    if os.path.exists(paths.NFT_FILE):
        _firewall_load(lambda _m: None)  # type: ignore[arg-type]
    else:
        run(["nft", "delete", "table", "inet", "church_signage"])
    os.unlink(pending)
    log("SSH and firewall settings put back")
    return True


def confirm(token: str, ssh_connection: str) -> Dict[str, object]:
    """The dashboard's second login worked: keep the change, lock the setup password if wanted, finish what waited."""
    pending = os.path.join(paths.PENDING, f"{token}.json")
    state = read_json(pending)
    if not state:
        raise ApplyError("nothing is waiting for that confirmation (it was undone, or already confirmed)")
    os.unlink(pending)
    c = state["config"]
    done: List[str] = []
    if c["lockSetupPassword"] and c["loginAccount"] == "dedicated" and c["setupUser"] != render.login_user(c):
        if c["setupUser"] in _users():
            run(["passwd", "-l", c["setupUser"]])
            done.append(f"locked the password of {c['setupUser']}")
    return {"confirmed": True, "done": done, "from": ssh_connection.split(" ")[0] if ssh_connection else None}


def overlay(c: Dict, log: Log) -> bool:
    """Read-only root on or off (raspi-config). Returns whether a reboot is needed for it to take effect."""
    log.step("overlay")
    if simulated() or not have("raspi-config"):
        log("read-only root: not available here")
        return False
    active = overlay_active()
    if c["readOnlyRoot"] == active:
        log(f"read-only root already {'on' if active else 'off'}")
        return False
    if c["readOnlyRoot"]:
        code, _, err = run(["raspi-config", "nonint", "enable_overlayfs"], timeout=600)
        if code != 0:
            raise ApplyError(f"could not turn the read-only root on: {err.strip()}")
        log("read-only root turned on (after the reboot)")
    else:
        code, _, err = run(["raspi-config", "nonint", "disable_overlayfs"], timeout=600)
        if code != 0:
            raise ApplyError(f"could not turn the read-only root off: {err.strip()}")
        log("read-only root turned off (after the reboot)")
    return True


def apply(raw: bytes) -> Dict[str, object]:
    log = Log()
    try:
        c = render.check_config(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError) as e:
        raise ApplyError(f"bad settings: {e}") from None
    facts = check(log)
    packages(log)
    accounts(c, log)
    agent_units(log)
    reboot = system(c, log)
    lock = lockdown(c, log)
    reboot = overlay(c, log) or reboot
    applied = {"hash": hashlib.sha256(raw).hexdigest(), "config": c, "at": time.time()}
    write_json(paths.APPLIED, applied, 0o600)
    log.step("done")
    return {"ok": True, "facts": facts, "token": lock["token"], "reboot": reboot, "settingsHash": applied["hash"], "log": log.lines}


def _home(user: str) -> str:
    try:
        with open(paths.p("/etc/passwd"), encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split(":")
                if parts[0] == user and len(parts) > 5:
                    return paths.p(parts[5]) if paths.ROOT else parts[5]
    except OSError:
        pass
    raise ApplyError(f"there is no {user} account")


def _chown(user: str, path: str) -> None:
    if paths.ROOT:
        return
    shutil.chown(path, user, user)


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _read_or_none(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None
