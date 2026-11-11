"""What `signage-ctl status` reports (signagePiStatusSchema in packages/shared/src/signage/schemas.ts)."""

import os
import re
import shutil
import time
from typing import Dict, Optional, Tuple

from . import manifest as mf
from . import media, paths, render, version
from .apply import model, os_release
from .util import have, overlay_active, read_json, run, write_json


def _read(path: str) -> str:
    try:
        with open(paths.p(path), encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def cpu_temp() -> Optional[float]:
    t = _read("/sys/class/thermal/thermal_zone0/temp").strip()
    return round(int(t) / 1000, 1) if t.isdigit() else None


def _cpu_times() -> Optional[Tuple[int, int]]:
    """(busy, total) jiffies of all cores from the first line of /proc/stat. guest time is already inside user."""
    line = _read("/proc/stat").split("\n", 1)[0].split()
    if len(line) < 9 or line[0] != "cpu":
        return None
    try:
        v = [int(x) for x in line[1:9]]
    except ValueError:
        return None
    idle = v[3] + v[4]
    total = sum(v)
    return total - idle, total


def cpu_percent() -> Optional[float]:
    """How busy the CPU has been, 0-100 over all cores: since the previous status read when that was 1 s to 15 min ago (the
    average over the poll interval, so a spike between polls still counts), else over a short 0.5 s sample."""
    cur = _cpu_times()
    if cur is None:
        return None
    now = time.time()
    prev = read_json(paths.CPU_SAMPLE)
    try:
        os.makedirs(os.path.dirname(paths.CPU_SAMPLE), exist_ok=True)
        write_json(paths.CPU_SAMPLE, {"at": now, "busy": cur[0], "total": cur[1]})
    except OSError:
        pass
    base = None
    if isinstance(prev, dict) and all(isinstance(prev.get(k), (int, float)) for k in ("at", "busy", "total")):
        if 1 <= now - prev["at"] <= 900 and cur[1] > prev["total"] and cur[0] >= prev["busy"]:
            base = (int(prev["busy"]), int(prev["total"]))
    if base is None:
        time.sleep(0.5)
        later = _cpu_times()
        if later is None:
            return None
        base, cur = cur, later
    total = cur[1] - base[1]
    if total <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * (cur[0] - base[0]) / total)), 1)


def throttled() -> Optional[str]:
    if not have("vcgencmd"):
        return None
    code, out, _ = run(["vcgencmd", "get_throttled"], timeout=5)
    m = re.search(r"throttled=(0x[0-9a-fA-F]+)", out)
    return m.group(1) if code == 0 and m else None


def under_voltage(flags: Optional[str]) -> bool:
    """Bit 0 = under-voltage now, bit 16 = under-voltage has happened since boot."""
    if not flags:
        return False
    v = int(flags, 16)
    return bool(v & 0x1 or v & 0x10000)


def wifi() -> Dict[str, object]:
    if not have("iw"):
        return {}
    code, out, _ = run(["iw", "dev", "wlan0", "link"], timeout=5)
    if code != 0 or "Not connected" in out:
        return {"wifiSsid": None, "wifiRssiDbm": None, "wifiBand": None}
    ssid = re.search(r"SSID:\s*(.+)", out)
    sig = re.search(r"signal:\s*(-?\d+)", out)
    freq = re.search(r"freq:\s*(\d+)", out)
    band = None
    if freq:
        f = int(freq.group(1))
        band = "2.4GHz" if f < 3000 else ("5GHz" if f < 5925 else "6GHz")
    return {"wifiSsid": ssid.group(1).strip()[:64] if ssid else None, "wifiRssiDbm": int(sig.group(1)) if sig else None, "wifiBand": band}


def clock_synced() -> bool:
    if have("timedatectl"):
        code, out, _ = run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], timeout=5)
        if code == 0:
            return out.strip() == "yes"
    return os.path.exists(paths.p("/run/systemd/timesync/synchronized"))


def mem_free_mb() -> Optional[float]:
    m = re.search(r"MemAvailable:\s+(\d+)", _read("/proc/meminfo"))
    return round(int(m.group(1)) / 1024) if m else None


def os_updates_pending() -> Optional[int]:
    """Upgradable packages from apt's own lists (refreshed by the OS update job); no network here."""
    if not have("apt-get"):
        return None
    code, out, _ = run(["apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade"], timeout=60)
    if code != 0:
        return None
    return len([ln for ln in out.splitlines() if ln.startswith("Inst ")])


def settings_state() -> Dict[str, object]:
    """The applied settings' hash, but only when the live sshd agrees with them (else the drift)."""
    applied = read_json(paths.APPLIED)
    if not applied:
        return {"settingsHash": None, "settingsDrift": []}
    drift = []
    if have("sshd"):
        code, out, _ = run(["sshd", "-T", "-C", "user=nobody,host=x,addr=127.0.0.1"], timeout=10)
        if code == 0:
            drift = render.sshd_drift(applied["config"], render.parse_sshd_t(out))
    if bool(applied["config"].get("readOnlyRoot")) != overlay_active() and not os.path.exists(paths.SIMULATED) and have("raspi-config"):
        drift.append("read-only root is " + ("on" if overlay_active() else "off"))
    return {"settingsHash": None if drift else applied["hash"], "settingsDrift": drift}


def collect(full: bool = True) -> Dict[str, object]:
    rel = os_release()
    disk = shutil.disk_usage(paths.DATA if os.path.isdir(paths.DATA) else paths.p("/"))
    m = mf.load(paths.MANIFEST)
    player = read_json(paths.STATUS_CACHE, {}) or {}
    fresh = player and time.time() - float(player.get("at", 0)) < 90
    missing = 0
    if m:
        have_media = set(media.listing()["media"].keys()) if os.path.isdir(paths.MEDIA) else set()
        missing = len([s for s in m["media"] if s not in have_media])
    ident = read_json(paths.IDENTIFY)
    flags = throttled()
    out: Dict[str, object] = {
        "agentVersion": version(),
        "osVersion": rel.get("PRETTY_NAME", "")[:120],
        "model": model()[:120],
        "serial": _serial(),
        "hostname": os.uname().nodename[:120],
        "uptimeS": _uptime(),
        "cpuTempC": cpu_temp(),
        "cpuPct": cpu_percent(),
        "throttled": flags,
        "underVoltage": under_voltage(flags),
        "diskFreeMb": round(disk.free / 1048576),
        "diskTotalMb": round(disk.total / 1048576),
        "memFreeMb": mem_free_mb(),
        "clockSynced": clock_synced(),
        "clock": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "manifestVersion": m["version"] if m else None,
        "missingMedia": missing,
        "nowPlaying": player.get("nowPlaying") if fresh else None,
        "playerRunning": bool(fresh and player.get("running")),
        "tvPower": player.get("tvPower", "unknown") if fresh else "unknown",
        "tvInput": player.get("tvInput") if fresh else None,
        "tvError": player.get("tvError") if fresh else None,
        "roku": player.get("roku") if fresh else None,
        "displayMode": player.get("displayMode") if fresh else None,
        "decoder": player.get("decoder") if fresh else None,
        "playback": player.get("playback") if fresh else None,
        "osUpdateState": (read_json(paths.OS_UPDATE_STATE) or {}).get("state"),
        "identifyUntil": ident.get("until") if ident and ident.get("untilTs", 0) > time.time() else None,
        "readOnlyRoot": overlay_active(),
        "lastError": player.get("lastError") if fresh else None,
    }
    out.update(wifi())
    out.update(settings_state())
    if full:
        out["osUpdatesPending"] = os_updates_pending()
    return out


def _serial() -> Optional[str]:
    m = re.search(r"^Serial\s*:\s*([0-9a-fA-F]+)", _read("/proc/cpuinfo"), re.M)
    if m:
        return m.group(1)[-16:]
    s = _read("/sys/firmware/devicetree/base/serial-number").rstrip("\0").strip()
    return s[-16:] or None


def _uptime() -> Optional[float]:
    t = _read("/proc/uptime").split()
    return round(float(t[0])) if t else None


def macs() -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    for dev, key in (("eth0", "eth"), ("wlan0", "wlan")):
        a = _read(f"/sys/class/net/{dev}/address").strip()
        out[key] = a.upper() if a else None
    return out
