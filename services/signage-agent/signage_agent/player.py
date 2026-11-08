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


def mpv_args(orientation: str, hwdec: str = "auto-safe") -> List[str]:
    args = [
        "mpv",
        "--idle=yes",
        "--force-window=yes",
        "--vo=gpu",
        "--gpu-context=drm",
        f"--hwdec={hwdec}",
        f"--input-ipc-server={SOCK}",
        "--no-input-default-bindings",
        "--input-vo-keyboard=no",
        "--no-osc",
        "--osd-level=0",
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
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def command(self, *args) -> Optional[Dict]:
        return self.raw({"command": list(args)})

    def raw(self, msg: Dict) -> Optional[Dict]:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(2)
            s.connect(SOCK)
            s.sendall((json.dumps(msg) + "\n").encode())
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
            s.close()
            for line in buf.split(b"\n"):
                if line.strip():
                    r = json.loads(line)
                    if "error" in r:
                        return r
            return None
        except (OSError, ValueError):
            return None

    def show(self, path: str, loop: bool) -> None:
        if self.current == path:
            return
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
