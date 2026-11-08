"""The daemon (`signage-agent.service`): plays the manifest, drives the TV, tidies media, runs OS updates in their window.

No network listener. Everything it is told arrives as files written by `signage-ctl` over SSH."""

import os
import signal
import socket
import time
from datetime import datetime
from typing import Dict, Optional

from . import manifest as mf
from . import media, osupdate, paths, player, schedule, status, tv
from .util import read_json, write_json

TICK_S = 0.5
TV_CHECK_S = 60
TV_RETRY_S = 20
HOUSEKEEP_S = 3600
OS_CHECK_S = 300


def sd_notify(msg: str) -> None:
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    if addr.startswith("@"):
        addr = "\0" + addr[1:]
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.connect(addr)
        s.sendall(msg.encode())
        s.close()
    except OSError:
        pass


class Sequencer:
    """Which item of the current timeline entry is on now. A playlist restarts at each entry; items whose file is not
    here yet are skipped; a picture's or video's slot is its `dur` seconds."""

    def __init__(self) -> None:
        self.key: Optional[str] = None
        self.index = 0
        self.started = 0.0

    def current(self, m: Optional[dict], now: float, synced: bool, have: set) -> Dict:
        entry = mf.entry_at(m, now) if (m and synced) else None
        items = mf.items_for(m, entry) if m else []
        playable = [i for i in items if i["m"] in have]
        key = f"{entry['start']}|{entry.get('playlist')}" if entry else f"fallback|{m.get('fallbackPlaylist') if m else None}"
        if key != self.key:
            self.key, self.index, self.started = key, 0, now
        if not playable:
            return {"item": None, "entry": entry}
        self.index %= len(playable)
        guard = 0
        while now - self.started >= float(playable[self.index]["dur"]) and guard < 1000:
            self.started += float(playable[self.index]["dur"])
            self.index = (self.index + 1) % len(playable)
            guard += 1
        if guard >= 1000:
            self.started = now
        return {"item": playable[self.index], "entry": entry}


class Agent:
    def __init__(self) -> None:
        self.manifest: Optional[dict] = None
        self.manifest_mtime = 0.0
        self.seq = Sequencer()
        cfg = read_json(paths.LOCAL_CONFIG, {}) or {}
        self.mpv = player.Mpv(hwdec=cfg.get("hwdec", "auto-safe"))
        self.tv_state: Dict[str, object] = {"tvPower": "unknown", "tvInput": None, "tvError": None, "roku": None}
        self.tv_next_check = 0.0
        self.tv_wanted_applied: Optional[str] = None
        self.tv_retry_at = 0.0
        self.last_housekeep = 0.0
        self.last_os_check = 0.0
        self.last_status = 0.0
        self.last_error: Optional[str] = None
        self.stop = False

    def load_manifest(self) -> None:
        try:
            mt = os.stat(paths.MANIFEST).st_mtime
        except OSError:
            return
        if mt != self.manifest_mtime:
            m = mf.load(paths.MANIFEST)
            self.manifest_mtime = mt
            if m:
                self.manifest = m
                if self.mpv.orientation != m.get("orientation", "landscape"):
                    self.mpv.orientation = m.get("orientation", "landscape")
                    self.mpv.stop()
            else:
                self.last_error = "the manifest on disk could not be read; keeping the previous one"

    def play(self, now: float, synced: bool) -> Dict:
        if not self.mpv.running():
            self.mpv.start()
        have = set(media.listing()["media"].keys())
        cur = self.seq.current(self.manifest, now, synced, have)
        ident = read_json(paths.IDENTIFY)
        if ident and ident.get("untilTs", 0) > now:
            self.mpv.overlay(player.identify_ass(ident.get("code", "???"), ident.get("label", "")))
        elif cur["item"] is None:
            self.mpv.overlay(player.logo_ass(os.uname().nodename if self.manifest else "Waiting for the dashboard"))
        else:
            self.mpv.overlay(None)
        if cur["item"] is None:
            self.mpv.blank()
        else:
            it = cur["item"]
            self.mpv.show(media.path_of(it["m"]), loop=it.get("kind") == "video")
        return cur

    def drive_tv(self, now: float, synced: bool) -> None:
        if not self.manifest or not synced:
            return
        block = self.manifest.get("tv") or {}
        try:
            drv = tv.driver(block)
        except tv.TvError as e:
            self.tv_state["tvError"] = str(e)
            return
        if drv is None:
            return
        wanted = mf.power_at(self.manifest, now)
        try:
            if now >= self.tv_next_check:
                info = drv.info()
                self.tv_state.update({"tvPower": info["power"], "tvError": None})
                if isinstance(drv, tv.Roku):
                    self.tv_state["roku"] = {"ip": block.get("rokuIp"), "serial": info.get("serial"), "model": info.get("model")}
                self.tv_next_check = now + TV_CHECK_S
            if wanted is not None and now >= self.tv_retry_at:
                have_state = self.tv_state.get("tvPower")
                if (wanted == "on" and have_state != "on") or (wanted == "off" and have_state == "on"):
                    drv.power(wanted)
                    if wanted == "on" and block.get("input"):
                        time.sleep(3)
                        drv.input(block["input"])
                        self.tv_state["tvInput"] = block["input"]
                    self.tv_retry_at = now + TV_RETRY_S
                    self.tv_next_check = now + 8
        except tv.TvError as e:
            self.tv_state["tvError"] = str(e)[:300]
            self.tv_retry_at = now + TV_RETRY_S
            self.tv_next_check = now + TV_RETRY_S
            # A Roku TV also answers CEC: try it as a backup.
            if block.get("control") == "roku_ecp" and wanted is not None:
                try:
                    tv.Cec().power(wanted)
                except tv.TvError:
                    pass

    def housekeep(self, now: float) -> None:
        if now - self.last_housekeep < HOUSEKEEP_S:
            return
        self.last_housekeep = now
        wanted = set(self.manifest["media"].keys()) if self.manifest else set()
        try:
            media.housekeep(wanted, now)
        except OSError as e:
            self.last_error = f"tidying media failed: {e}"

    def os_window(self, now: float) -> None:
        if now - self.last_os_check < OS_CHECK_S:
            return
        self.last_os_check = now
        applied = read_json(paths.APPLIED) or {}
        window = (applied.get("config") or {}).get("osUpdateWindow") or ""
        try:
            windows = schedule.parse(window)
        except ValueError:
            return
        if not windows or not schedule.active(windows, datetime.now()):
            return
        s = osupdate.state()
        if s.get("phase") or now - float(s.get("finishedAt") or 0) < 20 * 3600:
            return
        pending = status.os_updates_pending()
        if pending:
            from .ctl import spawn_detached

            spawn_detached(["os-update-run"])

    def write_status(self, now: float, cur: Dict) -> None:
        if now - self.last_status < 10:
            return
        self.last_status = now
        item = cur.get("item")
        entry = cur.get("entry")
        write_json(
            paths.STATUS_CACHE,
            {
                "at": now,
                "running": self.mpv.running(),
                "nowPlaying": {"playlist": (entry or {}).get("playlist") or (self.manifest or {}).get("fallbackPlaylist"), "media": item["m"][:12] if item else None, "source": (entry or {}).get("source") or ("fallback" if item else "logo")},
                "displayMode": player.display_mode(),
                "lastError": self.last_error,
                **self.tv_state,
            },
        )
        try:
            with open(paths.HEALTHY, "w", encoding="utf-8") as f:
                f.write(str(now))
        except OSError:
            pass

    def run(self) -> None:
        os.makedirs(paths.RUN, exist_ok=True)
        osupdate.resume_after_boot()
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stop", True))
        signal.signal(signal.SIGUSR1, lambda *_: self.mpv.stop())
        sd_notify("READY=1")
        synced, synced_at = False, 0.0
        while not self.stop:
            now = time.time()
            if now - synced_at > 30:
                synced, synced_at = status.clock_synced(), now
            try:
                self.load_manifest()
                cur = self.play(now, synced)
                self.drive_tv(now, synced)
                self.housekeep(now)
                self.os_window(now)
                self.write_status(now, cur)
                sd_notify("WATCHDOG=1")
            except Exception as e:  # keep playing whatever goes wrong; the dashboard sees lastError
                self.last_error = f"{type(e).__name__}: {e}"[:500]
            time.sleep(TICK_S)
        self.mpv.stop()


def main() -> None:
    Agent().run()
