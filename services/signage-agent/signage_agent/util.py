"""Small helpers: running programs (argument lists, never a shell), writing files atomically, the read-only root."""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from typing import Dict, List, Optional, Sequence, Tuple

from . import paths


def run(args: Sequence[str], timeout: float = 60, input_bytes: Optional[bytes] = None, env: Optional[Dict[str, str]] = None) -> Tuple[int, str, str]:
    """Run a program; (exit code, stdout, stderr). A missing program is exit 127, a time-out 124."""
    try:
        r = subprocess.run(list(args), input=input_bytes, capture_output=True, timeout=timeout, env=env or {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
        return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not installed"
    except subprocess.TimeoutExpired:
        return 124, "", f"{args[0]}: timed out after {timeout:.0f} s"


def have(program: str) -> bool:
    return shutil.which(program, path="/usr/sbin:/usr/bin:/sbin:/bin") is not None


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def overlay_active() -> bool:
    """raspi-config's overlay file system: the real root is mounted at /media/root-ro and / is a RAM overlay."""
    try:
        with open(paths.p("/proc/mounts"), encoding="utf-8") as f:
            return any(line.split()[1] == paths.OVERLAY_LOWER for line in f if len(line.split()) > 1)
    except OSError:
        return False


def _write(path: str, data: bytes, mode: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.ismount(path):
        # A bind-mounted file (/etc/hostname in a container) cannot be replaced, only rewritten.
        with open(path, "wb") as f:
            f.write(data)
        return
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_file(path: str, content, mode: int = 0o644, persist: bool = True) -> bool:
    """Write a file atomically; True when it changed. With the read-only root on, a system file is also written to the
    real root underneath, or the change would be gone after the next reboot."""
    data = content.encode("utf-8") if isinstance(content, str) else content
    try:
        with open(path, "rb") as f:
            if f.read() == data and (os.stat(path).st_mode & 0o7777) == mode:
                return False
    except OSError:
        pass
    _write(path, data, mode)
    if persist and overlay_active() and not path.startswith(paths.DATA):
        lower = paths.OVERLAY_LOWER + (path[len(paths.ROOT):] if paths.ROOT else path)
        run(["mount", "-o", "remount,rw", paths.OVERLAY_LOWER])
        _write(lower, data, mode)
    return True


def remove_file(path: str) -> bool:
    removed = False
    for p in [path] + ([paths.OVERLAY_LOWER + path] if overlay_active() else []):
        try:
            os.unlink(p)
            removed = True
        except FileNotFoundError:
            pass
    return removed


def read_json(path: str, default=None):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: str, value, mode: int = 0o644, durable: bool = False) -> None:
    """`durable`: a note that must survive the next restart even with the read-only root on (a reset or OS update that
    carries on after the reboot). It is then also written to the real root underneath. /var/lib/signage is normally
    bind-mounted from there already (signage-data.service), in which case this writes the same file twice; the second
    copy is for when that mount is missing, which nothing else would notice until the note was gone."""
    body = json.dumps(value, sort_keys=True, separators=(",", ":"))
    write_file(path, body, mode, persist=False)
    if durable and overlay_active():
        lower = paths.OVERLAY_LOWER + (path[len(paths.ROOT):] if paths.ROOT else path)
        run(["mount", "-o", "remount,rw", paths.OVERLAY_LOWER])
        _write(lower, body.encode("utf-8"), mode)


def users() -> List[str]:
    try:
        with open(paths.p("/etc/passwd"), encoding="utf-8") as f:
            return [line.split(":")[0] for line in f if ":" in line]
    except OSError:
        return []
