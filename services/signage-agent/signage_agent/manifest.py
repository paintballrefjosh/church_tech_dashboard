"""The manifest the dashboard compiles for this screen (packages/shared/src/signage/compile.ts), read the same way."""

import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

MAX_BYTES = 4 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{64}$")


class ManifestError(ValueError):
    pass


def parse_instant(s: str) -> float:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def validate(raw: bytes) -> dict:
    """Check a manifest's shape before it replaces the current one. Raises ManifestError with a reason."""
    if len(raw) > MAX_BYTES:
        raise ManifestError("manifest too large")
    try:
        m = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ManifestError(f"not JSON: {e}") from None
    if not isinstance(m, dict) or m.get("format") != 1:
        raise ManifestError("unknown manifest format")
    for key in ("version", "screenId", "validFrom", "validUntil", "timeline", "playlists", "media", "power"):
        if key not in m:
            raise ManifestError(f"missing {key}")
    if not isinstance(m["version"], int):
        raise ManifestError("version must be a number")
    media = m["media"]
    if not isinstance(media, dict) or not all(SHA.match(k) for k in media):
        raise ManifestError("bad media list")
    playlists = m["playlists"]
    if not isinstance(playlists, dict):
        raise ManifestError("bad playlists")
    for items in playlists.values():
        if not isinstance(items, list):
            raise ManifestError("bad playlist")
        for it in items:
            if not isinstance(it, dict) or it.get("m") not in media or not isinstance(it.get("dur"), (int, float)):
                raise ManifestError("bad playlist item")
    for e in m["timeline"]:
        parse_instant(e["start"])
        parse_instant(e["end"])
        if e.get("playlist") is not None and e["playlist"] not in playlists:
            raise ManifestError("timeline names a missing playlist")
    for p in m["power"]:
        parse_instant(p["at"])
        if p.get("state") not in ("on", "off"):
            raise ManifestError("bad power entry")
    return m


def load(path: str) -> Optional[dict]:
    try:
        with open(path, "rb") as f:
            return validate(f.read())
    except (OSError, ManifestError, KeyError, TypeError, ValueError):
        return None


def entry_at(m: dict, at: float) -> Optional[dict]:
    for e in m.get("timeline", []):
        if parse_instant(e["start"]) <= at < parse_instant(e["end"]):
            return e
    return None


def power_at(m: dict, at: float) -> Optional[str]:
    """The TV's wanted power at `at`: "on", "off", or None when this screen's power is not managed."""
    state = m.get("powerInitial")
    if state is None:
        return None
    for e in m.get("power", []):
        if parse_instant(e["at"]) > at:
            break
        state = e["state"]
    return state


def next_power_change(m: dict, at: float) -> Optional[float]:
    for e in m.get("power", []):
        t = parse_instant(e["at"])
        if t > at:
            return t
    return None


def items_for(m: dict, entry: Optional[dict]) -> list:
    """The playable items of an entry (or of the fallback playlist when no entry applies)."""
    key: Any = entry.get("playlist") if entry else m.get("fallbackPlaylist")
    if not key:
        return []
    return list(m.get("playlists", {}).get(key, []))
