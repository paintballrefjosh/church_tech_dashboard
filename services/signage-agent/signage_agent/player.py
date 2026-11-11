"""mpv on DRM/KMS, driven over its JSON IPC socket. The agent decides what plays and when; mpv only shows it.

mpv runs as the unprivileged `signage-player` account. Pictures are shown until the agent moves on; a video shorter than
its slot loops, a longer one is cut."""

import json
import os
import socket
import subprocess
import time
from typing import Dict, List, Optional

from . import paths

SOCK = os.path.join(paths.RUN, "mpv", "mpv.sock")


def default_hwdec(model: str) -> str:
    """The decoder for this Pi (docs/signage.md section 10). A Pi 3 or 4 decodes H.264 in hardware only through the V4L2
    memory-to-memory codec, which mpv's `auto-safe` never picks, so it decoded 1080p on the CPU: choppy on a Pi 3B+ and a
    hot, throttled board (seen 2026-11-11). The `-copy` form works with `--vo=gpu`; if the codec is missing mpv falls back
    to software by itself. A Pi 5 has no H.264 decoder (its CPU copes) and its HEVC one is `drm`, which `auto-safe` picks."""
    m = (model or "").lower()
    if any(k in m for k in ("raspberry pi 3", "raspberry pi 4", "compute module 3", "compute module 4", "raspberry pi 400")):
        return "v4l2m2m-copy"
    return "auto-safe"


# mpv's own default queue depth, used while a video plays.
VIDEO_SWAPCHAIN = 3


def mpv_args(orientation: str, hwdec: str = "auto-safe") -> List[str]:
    args = [
        "mpv",
        "--idle=yes",
        "--force-window=yes",
        "--vo=gpu",
        "--gpu-context=drm",
        # One frame in the queue while a picture is up (show() switches it per item). On DRM a frame reaches the screen only
        # when later frames push it out, and a picture is drawn once: two pictures of the same size in a row left the first on
        # the TV for both slots (2026-11-11; a size change makes mpv redraw several times, which hid it). Video gets mpv's
        # default of 3 back: with 1, mpv waits for every refresh before drawing the next frame (about 10 fps on a Pi 3B+).
        "--swapchain-depth=1",
        f"--hwdec={hwdec}",
        f"--input-ipc-server={SOCK}",
        "--no-input-default-bindings",
        "--input-vo-keyboard=no",
        "--no-osc",
        # Level 1, not 0: level 0 switches the OSD off entirely and with it the identify code and the logo slide (osd-overlay).
        # Nothing can trigger the on-screen controller or messages here (no input, no OSC), so level 1 shows only our own text.
        "--osd-level=1",
        "--no-audio",
        "--keep-open=yes",
        "--image-display-duration=inf",
        "--background=color",
        "--background-color=#000000",
        "--really-quiet",
        "--no-terminal",
        "--msg-level=all=error",
    ]
    if orientation == "portrait":
        args.append("--video-rotate=90")
    return args


class Mpv:
    def __init__(self, orientation: str = "landscape", hwdec: str = "auto-safe") -> None:
        self.orientation = orientation
        self.hwdec = hwdec
        self.proc: Optional[subprocess.Popen] = None
        self.current: Optional[str] = None
        self.overlay_text: Optional[str] = None
        self._sock: Optional[socket.socket] = None
        self._buf = b""
        self._rid = 0

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        if self.running():
            return
        os.makedirs(os.path.dirname(SOCK), exist_ok=True)
        try:
            import pwd

            pw = pwd.getpwnam(paths.PLAYER_USER)
            os.chown(os.path.dirname(SOCK), pw.pw_uid, pw.pw_gid)
            kw = {"user": pw.pw_uid, "group": pw.pw_gid, "extra_groups": _groups(paths.PLAYER_USER)}
        except (KeyError, PermissionError, OSError):
            kw = {}
        try:
            os.unlink(SOCK)
        except OSError:
            pass
        self.proc = subprocess.Popen(
            mpv_args(self.orientation, self.hwdec),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"},
            **kw,
        )
        self.current = None
        self.overlay_text = None
        for _ in range(50):
            if os.path.exists(SOCK):
                break
            time.sleep(0.1)

    def stop(self) -> None:
        self._close()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def command(self, *args) -> Optional[Dict]:
        return self.raw({"command": list(args)})

    def _close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def raw(self, msg: Dict) -> Optional[Dict]:
        """One command on a connection that stays open. It must: mpv removes an `osd-overlay` the moment the connection that
        made it closes, so a connection per command drew the identify code and the logo slide for no time at all."""
        self._rid += 1
        rid = self._rid
        out = dict(msg, request_id=rid)
        try:
            if self._sock is None:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(2)
                s.connect(SOCK)
                self._sock = s
                self._buf = b""
                self.overlay_text = None  # overlays belonged to the old connection: draw them again
            self._sock.sendall((json.dumps(out) + "\n").encode())
            while True:
                while b"\n" in self._buf:
                    line, self._buf = self._buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    r = json.loads(line)
                    if r.get("request_id") == rid and "error" in r:
                        return r
                chunk = self._sock.recv(65536)
                if not chunk:
                    raise OSError("mpv closed the connection")
                self._buf += chunk
        except (OSError, ValueError):
            self._close()
            return None

    def show(self, path: str, loop: bool) -> None:
        if self.current == path:
            return
        self.command("set_property", "swapchain-depth", VIDEO_SWAPCHAIN if loop else 1)
        self.command("set_property", "loop-file", "inf" if loop else "no")
        self.command("loadfile", path, "replace")
        self.current = path

    def blank(self) -> None:
        if self.current is not None:
            self.command("stop")
            self.current = None

    def overlay(self, text: Optional[str]) -> None:
        """A full-screen text over playback (identify codes, the logo slide). None removes it."""
        if text == self.overlay_text:
            return
        if text is None:
            self.raw({"command": {"name": "osd-overlay", "id": 1, "format": "none", "data": ""}})
        else:
            self.raw({"command": {"name": "osd-overlay", "id": 1, "format": "ass-events", "data": text, "res_x": 1920, "res_y": 1080, "z": 10}})
        self.overlay_text = text

    def decoder(self) -> Optional[str]:
        """mpv's `hwdec-current`: the decoder in use for the video playing ("no" = software)."""
        r = self.command("get_property", "hwdec-current")
        if not r or r.get("error") != "success":
            return None
        return str(r.get("data"))[:40]

    def playback(self) -> Optional[Dict[str, object]]:
        """How the video on screen is playing: frames per second leaving the decoder and the file's own rate, and frames
        dropped since it started. A Pi that cannot keep up shows a `fps` well under `fileFps`."""
        out: Dict[str, object] = {}
        for key, prop in (("fps", "estimated-vf-fps"), ("fileFps", "container-fps"), ("dropped", "frame-drop-count"), ("decoderDropped", "decoder-frame-drop-count"), ("late", "vo-delayed-frame-count")):
            r = self.command("get_property", prop)
            if r and r.get("error") == "success" and isinstance(r.get("data"), (int, float)):
                out[key] = round(float(r["data"]), 1)
        return out or None

    def screenshot(self, path: str) -> bool:
        r = self.command("screenshot-to-file", path, "video")
        return r is not None and r.get("error") == "success" and os.path.exists(path)


def ass_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def identify_ass(code: str, label: str) -> str:
    return (
        "{\\an5\\pos(960,470)\\fs360\\b1\\bord12\\3c&H000000&\\1c&HFFFFFF&}" + ass_escape(code) + "\n"
        "{\\an5\\pos(960,760)\\fs72\\bord6\\3c&H000000&\\1c&HFFFFFF&}" + ass_escape(label)
    )


def logo_ass(text: str) -> str:
    return "{\\an5\\pos(960,540)\\fs64\\1c&H9A9A9A&}" + ass_escape(text)


def adopting_ass(n: int, total: int, words: str) -> str:
    """"Adopting Pi...", the step, and where it is in the list."""
    return (
        "{\\an5\\pos(960,400)\\fs110\\b1\\bord8\\3c&H000000&\\1c&HFFFFFF&}Adopting Pi...\n"
        "{\\an5\\pos(960,590)\\fs60\\bord5\\3c&H000000&\\1c&HE6E6E6&}" + ass_escape(words) + "\n"
        "{\\an5\\pos(960,690)\\fs46\\bord4\\3c&H000000&\\1c&HBDBDBD&}" + f"Step {n} of {total}"
    )


def display_mode() -> Optional[str]:
    base = paths.p("/sys/class/drm")
    try:
        for name in sorted(os.listdir(base)):
            if "HDMI-A" in name:
                with open(os.path.join(base, name, "status"), encoding="utf-8") as f:
                    if f.read().strip() != "connected":
                        continue
                with open(os.path.join(base, name, "modes"), encoding="utf-8") as f:
                    first = f.readline().strip()
                    return first or None
    except OSError:
        return None
    return None


def _groups(user: str) -> List[int]:
    import grp

    return [g.gr_gid for g in grp.getgrall() if user in g.gr_mem]
