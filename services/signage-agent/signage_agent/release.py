"""`signage-ctl release`: take the Pi back to a normal Raspberry Pi (the dashboard's "Forget", with reset on).

Undoes what `apply` did, keeping what the person had before: the first user and its password (unlocked again, the hash was only
locked), the Wi-Fi settings (never touched), the packages (left installed, harmless). Removed: the dashboard's key and SSH
rules, the firewall, the `signage` and player accounts, the agent, the media, the console-only boot, the boot options setup added.

With the read-only root on, nothing written now would survive a restart, so phase one lifts it (a reboot), and phase two runs on
the next boot (`resume_after_boot`, like an OS update). Both phases leave a note in `release.json` and the log in
`/var/tmp/lampstand-signage-release.log` (that folder is not removed)."""

import os
import shutil
import time
from typing import Dict, List, Optional

from . import paths
from .util import have, overlay_active, read_json, remove_file, run, write_file, write_json

# What setup added to the boot options (system() in apply.py); `quiet` is left alone, a desktop image has it too.
BOOT_TOKENS = ("consoleblank=", "vt.global_cursor_default=", "video=HDMI-A-1:1920x1080@60D")
UNITS = ["signage-agent.service", "signage-data.service", "signage-firewall.service"]


def state() -> Dict:
    return read_json(paths.RELEASE_STATE, {}) or {}


def _log(msg: str) -> None:
    try:
        os.makedirs(os.path.dirname(paths.RELEASE_LOG), exist_ok=True)
        with open(paths.RELEASE_LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except OSError:
        pass


def boot_id() -> str:
    """Changes at every restart: the dashboard compares it to tell "has not restarted yet" from "restarted and stopped"."""
    return _read(paths.p("/proc/sys/kernel/random/boot_id")).strip()


def _note(phase: str) -> None:
    # Durable: with the read-only root on, a note only in memory is gone after the restart and phase two never starts,
    # leaving the Pi locked down with nothing that can open it but the dashboard's key.
    write_json(paths.RELEASE_STATE, {"phase": phase, "at": time.time(), "bootId": boot_id()}, durable=True)


def start() -> Dict:
    """Phase one. `runNow` says the caller should start the work (no read-only root to lift first); otherwise the Pi reboots
    by itself and `resume_after_boot` carries on."""
    if overlay_active() and have("raspi-config") and not os.path.exists(paths.SIMULATED):
        try:
            _note("after-boot")
        except OSError as e:
            return {"error": f"could not save the reset's progress on the SD card ({e}); nothing was changed"}
        code, _, err = run(["raspi-config", "nonint", "disable_overlayfs"], timeout=600)
        if code != 0:
            remove_file(paths.RELEASE_STATE)
            return {"error": f"could not lift the read-only root: {err.strip()[-200:]}"}
        _log("read-only root lifted; restarting to carry on")
        return {"started": True, "runNow": False, "reboots": True, "bootId": boot_id()}
    _note("running")
    return {"started": True, "runNow": True, "reboots": True, "bootId": boot_id()}


def resume_after_boot() -> bool:
    """Called by the agent at start. True when the caller should start `release-run`."""
    s = state()
    if s.get("phase") == "after-boot" and overlay_active():
        _log("restarted, but the read-only root is still on: raspi-config did not turn it off, so the reset cannot carry on")
    return s.get("phase") == "after-boot" and not overlay_active()


def progress() -> Dict:
    """`signage-ctl release-status`: what the dashboard reads while it waits for a reset to finish (or to say why not)."""
    s = state()
    log = _read(paths.RELEASE_LOG).splitlines()[-20:]
    return {"phase": s.get("phase"), "startedBootId": s.get("bootId"), "bootId": boot_id(), "readOnlyRoot": overlay_active(), "log": log}


def _users() -> List[str]:
    from .util import users

    return users()


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def strip_boot_tokens(cmdline: str) -> str:
    args = [a for a in cmdline.split() if not any(a == t or a.startswith(t) for t in BOOT_TOKENS)]
    return " ".join(args) + "\n"


def without_keys(text: str, keys: List[str]) -> str:
    """authorized_keys without the lines that carry one of the dashboard's public keys (the person's own are kept)."""
    bodies = {k.split()[1] for k in keys if len(k.split()) >= 2}
    return "".join(ln + "\n" for ln in text.splitlines() if not any(b in ln for b in bodies))


def run_release() -> List[str]:
    """Phase two: do everything, then restart. Each step is independent: one that fails is logged and the rest go on."""
    done: List[str] = []

    def note(msg: str) -> None:
        done.append(msg)
        _log(msg)

    applied = read_json(paths.APPLIED, {}) or {}
    cfg = applied.get("config") or {}
    orig = read_json(paths.ORIGINAL, {}) or {}
    setup_user = cfg.get("setupUser") or "pi"
    systemd = have("systemctl") and not os.path.exists(paths.SIMULATED)

    def step(name: str, fn) -> None:
        try:
            fn()
        except Exception as e:  # keep going: a half reset is worse than a reset that skipped one thing
            note(f"{name}: failed ({type(e).__name__}: {e})")

    # The firewall first, so nothing blocks the SSH login that comes back.
    def firewall() -> None:
        run(["nft", "delete", "table", "inet", "lampstand_signage"])
        shutil.rmtree(paths.ETC, ignore_errors=True)
        note("firewall removed")

    # SSH: the dashboard's rules out, the Pi's own back (key lines that are not ours are kept).
    def ssh() -> None:
        remove_file(paths.SSHD_DROPIN)
        remove_file(paths.LEGACY_SSHD_DROPIN)
        keys = cfg.get("authorizedKeys") or []
        if cfg.get("loginAccount") != "dedicated":
            home = _home(setup_user)
            ak = os.path.join(home, ".ssh", "authorized_keys") if home else ""
            if ak and os.path.exists(ak):
                left = without_keys(_read(ak), keys)
                if left.strip():
                    write_file(ak, left, 0o600)
                else:
                    remove_file(ak)
        if have("sshd"):
            code, _, err = run(["sshd", "-t"])
            if code != 0:
                raise RuntimeError(f"sshd does not accept its settings: {err.strip()[-200:]}")
        if systemd:
            run(["systemctl", "reload", "ssh"])
        note("SSH settings put back (password login as before)")

    def password() -> None:
        if setup_user in _users():
            code, _, err = run(["passwd", "-u", setup_user])
            note(f"password of {setup_user} unlocked" if code == 0 else f"password of {setup_user}: {err.strip()[-160:] or 'not changed'}")

    def accounts() -> None:
        remove_file(paths.SUDOERS)
        for name in (paths.DEDICATED_USER, paths.PLAYER_USER):
            if name in _users() and name != setup_user:
                run(["pkill", "-u", name])
                code, _, err = run(["userdel", "-rf", name])
                note(f"{name} account removed" if code == 0 else f"{name} account: {err.strip()[-160:]}")

    def services() -> None:
        for u in UNITS:
            if systemd:
                run(["systemctl", "disable", u])
            remove_file(os.path.join(paths.SYSTEMD, u))
        if systemd:
            run(["systemctl", "daemon-reload"])
        note("agent services disabled (the player stops at the restart)")

    def boot() -> None:
        if systemd:
            run(["systemctl", "unmask", "getty@tty1.service"])
        desktop = orig.get("desktop")
        if desktop is None:  # setup ran before the original was remembered: a desktop session installed means it was a desktop image
            desktop = os.path.exists(paths.p("/usr/sbin/lightdm")) or os.path.exists(paths.p("/usr/bin/labwc"))
        if desktop and systemd:
            run(["systemctl", "set-default", "graphical.target"])
            if have("raspi-config"):
                run(["raspi-config", "nonint", "do_boot_behaviour", "B4"], timeout=120)
            note("boots to the desktop again")
        else:
            note("boots to the console login again")
        cmdline = paths.CMDLINE
        if os.path.exists(cmdline):
            body = orig.get("cmdline") or strip_boot_tokens(_read(cmdline))
            write_file(cmdline, body if body.endswith("\n") else body + "\n")
            note("boot options put back")

    def system() -> None:
        host = (orig.get("hostname") or "").strip()
        if host and _read(paths.p("/etc/hostname")).strip() != host:
            write_file(paths.p("/etc/hostname"), host + "\n")
            hosts = _read(paths.p("/etc/hosts"))
            lines = [ln for ln in hosts.splitlines() if not ln.startswith("127.0.1.1")]
            write_file(paths.p("/etc/hosts"), "\n".join(lines + [f"127.0.1.1\t{host}"]) + "\n")
            run(["hostname", host])
            note(f"host name back to {host}")
        link = orig.get("timezoneLink")
        if link:
            lp = paths.p("/etc/localtime")
            try:
                os.unlink(lp)
            except FileNotFoundError:
                pass
            os.symlink(link, lp)
            if orig.get("timezone"):
                write_file(paths.p("/etc/timezone"), orig["timezone"] + "\n")
            note("time zone put back")
        remove_file(paths.p("/etc/systemd/timesyncd.conf.d/lampstand-signage.conf"))
        remove_file(paths.p("/etc/NetworkManager/conf.d/lampstand-signage.conf"))

    def files() -> None:
        shutil.rmtree(paths.OPT, ignore_errors=True)
        remove_file(paths.CTL_LINK)
        shutil.rmtree(paths.DATA, ignore_errors=True)
        note("the agent, media and settings removed")

    for name, fn in (("firewall", firewall), ("ssh", ssh), ("password", password), ("accounts", accounts), ("services", services), ("boot", boot), ("system", system), ("files", files)):
        step(name, fn)
    note("restarting")
    if systemd:
        code, _, _ = run(["systemctl", "reboot"])
        if code != 0:
            run(["reboot", "-f"])
    return done


def _home(user: str) -> Optional[str]:
    try:
        with open(paths.p("/etc/passwd"), encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split(":")
                if parts[0] == user and len(parts) > 5:
                    return paths.p(parts[5]) if paths.ROOT else parts[5]
    except OSError:
        pass
    return None
