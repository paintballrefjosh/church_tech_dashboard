"""What the TV shows while the player is not running (the agent restarting or updating, the Pi rebooting).

The player draws over the text console (tty1). When mpv exits the TV falls back to that console, which still held whatever was
written there last: boot or shutdown lines. So before anything that stops the player, and whenever the agent starts, the
console is cleared and given one plain message. Best effort: never let it stop the work it describes."""

import fcntl
import os
import struct
import termios
from typing import Tuple

from . import paths
from .util import run

TTY = paths.p("/dev/tty1")
# Larger console fonts, best first; Raspberry Pi OS ships them with console-setup. The default 8x16 is tiny on a 1080p TV.
FONTS = ("Uni3-TerminusBold32x16", "Lat15-TerminusBold32x16", "Uni3-TerminusBold28x14", "Lat15-TerminusBold28x14")
FONT_DIR = "/usr/share/consolefonts"

UPDATING = "Updating the screen software"
RESTARTING_PLAYER = "Restarting the player"
RESTARTING = "Restarting"
STARTING = "Starting up"
UPDATING_SYSTEM = "Installing system updates"


def _size(fd: int) -> Tuple[int, int]:
    try:
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
        if rows and cols:
            return rows, cols
    except OSError:
        pass
    return 33, 120


def render(title: str, note: str, rows: int, cols: int) -> str:
    top = max(0, rows // 2 - 1)
    out = "\x1b[0m\x1b[?25l\x1b[2J\x1b[H" + "\n" * top
    out += "\x1b[1m" + title.center(cols).rstrip() + "\x1b[0m\n\n"
    out += note.center(cols).rstrip()
    return out


def _font() -> None:
    for name in FONTS:
        for ext in (".psf.gz", ".psf"):
            f = os.path.join(FONT_DIR, name + ext)
            if os.path.exists(f):
                run(["setfont", "-C", TTY, f], timeout=10)
                return


def say(title: str, note: str = "Back in a moment") -> bool:
    if not os.path.exists(TTY):
        return False
    try:
        _font()
        fd = os.open(TTY, os.O_WRONLY | os.O_NOCTTY)
        try:
            rows, cols = _size(fd)
            os.write(fd, render(title, note, rows, cols).encode())
        finally:
            os.close(fd)
        return True
    except OSError:
        return False
