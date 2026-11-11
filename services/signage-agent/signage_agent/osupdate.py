"""OS updates (apt-get upgrade), in the Signage OS update window or on "Update now".

With the read-only root on, an upgrade would land in RAM and vanish, so the overlay is lifted first (a reboot), the
upgrade runs on the next boot, the overlay goes back on and the Pi reboots again. The state is in os-update.json."""

import os
import time
from typing import Dict

from . import console, paths
from .util import have, overlay_active, read_json, run, write_json

ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive", "LANG": "C.UTF-8"}


def state() -> Dict:
    return read_json(paths.OS_UPDATE_STATE, {}) or {}


def _set(**kw) -> None:
    s = state()
    s.update(kw)
    s["changedAt"] = time.time()
    write_json(paths.OS_UPDATE_STATE, s, durable=True)  # read again after the restart that lifts the read-only root


def start() -> Dict:
    """Begin an update now. Returns at once; the work goes on in this (detached) process."""
    if overlay_active():
        _set(state="lifting the read-only root for the update", phase="upgrade-after-boot", startedAt=time.time())
        code, _, err = run(["raspi-config", "nonint", "disable_overlayfs"], timeout=600)
        if code != 0:
            _set(state=f"failed: could not lift the read-only root: {err.strip()[-200:]}", phase=None)
            return state()
        console.say(console.UPDATING_SYSTEM)
        run(["systemctl", "reboot"])
        return state()
    return upgrade(restore_overlay=False)


def upgrade(restore_overlay: bool) -> Dict:
    _set(state="updating packages", phase="upgrading", startedAt=state().get("startedAt", time.time()))
    code, _, err = run(["apt-get", "update"], timeout=900, env=ENV)
    if code == 0:
        code, _, err = run(["apt-get", "-y", "-o", "Dpkg::Options::=--force-confold", "upgrade"], timeout=3600, env=ENV)
    if code != 0:
        _set(state=f"failed: {err.strip()[-300:]}", phase=None, finishedAt=time.time())
    else:
        _set(state="up to date", phase=None, finishedAt=time.time())
    reboot = os.path.exists(paths.p("/run/reboot-required"))
    if restore_overlay and have("raspi-config"):
        run(["raspi-config", "nonint", "enable_overlayfs"], timeout=600)
        reboot = True
    if reboot and have("systemctl"):
        console.say(console.RESTARTING)
        run(["systemctl", "reboot"])
    return state()


def resume_after_boot() -> None:
    """Called by the agent at start: finish an update that lifted the read-only root before rebooting."""
    s = state()
    if s.get("phase") == "upgrade-after-boot" and not overlay_active():
        applied = read_json(paths.APPLIED) or {}
        upgrade(restore_overlay=bool((applied.get("config") or {}).get("readOnlyRoot")))
