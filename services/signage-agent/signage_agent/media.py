"""The media folder: files named by their sha256 (the dashboard's renditions). Copies are resumable and hash-checked."""

import hashlib
import os
import re
import shutil
import time
from typing import BinaryIO, Dict

from . import paths

SHA = re.compile(r"^[0-9a-f]{64}$")
MAX_FILE = 2 * 1024 * 1024 * 1024
KEEP_UNUSED_S = 7 * 86400


class MediaError(ValueError):
    pass


def _ensure() -> None:
    os.makedirs(paths.PARTIAL, exist_ok=True)


def listing() -> Dict[str, object]:
    _ensure()
    have: Dict[str, int] = {}
    for name in os.listdir(paths.MEDIA):
        if SHA.match(name):
            have[name] = os.path.getsize(os.path.join(paths.MEDIA, name))
    partial: Dict[str, int] = {}
    for name in os.listdir(paths.PARTIAL):
        if SHA.match(name):
            partial[name] = os.path.getsize(os.path.join(paths.PARTIAL, name))
    st = shutil.disk_usage(paths.DATA)
    return {"media": have, "partial": partial, "freeMb": round(st.free / 1048576), "totalMb": round(st.total / 1048576)}


def put(sha: str, offset: int, size: int, stream: BinaryIO) -> Dict[str, object]:
    """Append the bytes from `stream` at `offset` to the partial copy of `sha` (`size` bytes in all). When the copy is
    whole it is checked against its name and moved into place. Returns how much is there now."""
    if not SHA.match(sha):
        raise MediaError("bad sha256")
    if not (0 <= offset <= size <= MAX_FILE):
        raise MediaError("bad offset or size")
    _ensure()
    final = os.path.join(paths.MEDIA, sha)
    if os.path.exists(final):
        _drain(stream)
        return {"have": os.path.getsize(final), "done": True}
    part = os.path.join(paths.PARTIAL, sha)
    current = os.path.getsize(part) if os.path.exists(part) else 0
    if offset > current:
        _drain(stream)
        raise MediaError(f"offset {offset} is past what is here ({current})")
    with open(part, "r+b" if os.path.exists(part) else "wb") as f:
        f.truncate(offset)
        f.seek(offset)
        written = offset
        while True:
            chunk = stream.read(1 << 20)
            if not chunk:
                break
            written += len(chunk)
            if written > size:
                raise MediaError("more bytes than announced")
            f.write(chunk)
        f.flush()
        os.fsync(f.fileno())
    if written < size:
        return {"have": written, "done": False}
    h = hashlib.sha256()
    with open(part, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != sha:
        os.unlink(part)
        raise MediaError("the copy does not match its sha256 (removed; send it again)")
    os.replace(part, final)
    return {"have": size, "done": True}


def _drain(stream: BinaryIO) -> None:
    while stream.read(1 << 20):
        pass


def housekeep(wanted: set, now: float = None, min_free_fraction: float = 0.15) -> int:
    """Remove media no manifest wants once unused for 7 days (sooner while the disk is under 15% free); partial copies
    of unwanted files go after a day. Returns how many files went."""
    _ensure()
    now = now if now is not None else time.time()
    removed = 0
    st = shutil.disk_usage(paths.DATA)
    low = st.total and st.free / st.total < min_free_fraction
    for folder, keep in ((paths.MEDIA, KEEP_UNUSED_S), (paths.PARTIAL, 86400)):
        for name in os.listdir(folder):
            full = os.path.join(folder, name)
            if not SHA.match(name) or name in wanted or not os.path.isfile(full):
                continue
            age = now - os.stat(full).st_atime if os.stat(full).st_atime > os.stat(full).st_mtime else now - os.stat(full).st_mtime
            if low or age > keep:
                os.unlink(full)
                removed += 1
    return removed


def path_of(sha: str) -> str:
    return os.path.join(paths.MEDIA, sha)
