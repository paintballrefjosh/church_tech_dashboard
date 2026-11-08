import json

import pytest

from signage_agent import manifest as mf
from signage_agent.agent import Sequencer

A = "a" * 64
B = "b" * 64


def m(**kw):
    base = {
        "format": 1,
        "version": 3,
        "screenId": "s1",
        "generatedAt": "2026-11-08T00:00:00Z",
        "validFrom": "2026-11-08T00:00:00Z",
        "validUntil": "2026-11-22T00:00:00Z",
        "timezone": "Europe/London",
        "orientation": "landscape",
        "media": {A: {"kind": "image", "bytes": 10}, B: {"kind": "video", "bytes": 20}},
        "playlists": {"p1~x": [{"m": A, "dur": 8, "kind": "image"}, {"m": B, "dur": 12, "kind": "video"}], "fb~y": [{"m": A, "dur": 5, "kind": "image"}]},
        "timeline": [{"start": "2026-11-08T10:00:00Z", "end": "2026-11-08T12:00:00Z", "playlist": "p1~x", "source": "schedule:1"}],
        "fallbackPlaylist": "fb~y",
        "powerInitial": "off",
        "power": [{"at": "2026-11-08T09:30:00Z", "state": "on"}, {"at": "2026-11-08T12:30:00Z", "state": "off"}],
        "tv": {"control": "none", "rokuIp": None, "input": None},
    }
    base.update(kw)
    return base


def t(s):
    return mf.parse_instant(s)


def test_validate_and_lookup():
    man = mf.validate(json.dumps(m()).encode())
    assert mf.entry_at(man, t("2026-11-08T11:00:00Z"))["source"] == "schedule:1"
    assert mf.entry_at(man, t("2026-11-08T12:00:00Z")) is None  # end is exclusive
    assert mf.power_at(man, t("2026-11-08T09:00:00Z")) == "off"
    assert mf.power_at(man, t("2026-11-08T09:30:00Z")) == "on"
    assert mf.power_at(man, t("2026-11-08T13:00:00Z")) == "off"
    assert mf.power_at(m(powerInitial=None), t("2026-11-08T10:00:00Z")) is None


@pytest.mark.parametrize(
    "bad",
    [
        {"format": 2},
        {"media": {"../etc/passwd": {}}},
        {"playlists": {"p1~x": [{"m": "c" * 64, "dur": 1}]}},
        {"timeline": [{"start": "2026-11-08T10:00:00Z", "end": "2026-11-08T12:00:00Z", "playlist": "nope"}]},
        {"power": [{"at": "2026-11-08T09:30:00Z", "state": "maybe"}]},
    ],
)
def test_validate_refuses(bad):
    with pytest.raises((mf.ManifestError, KeyError, ValueError)):
        mf.validate(json.dumps(m(**bad)).encode())


def test_sequencer_walks_items_and_restarts_per_entry():
    man = m()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    have = {A, B}
    assert s.current(man, start + 1, True, have)["item"]["m"] == A
    assert s.current(man, start + 9, True, have)["item"]["m"] == B
    assert s.current(man, start + 21, True, have)["item"]["m"] == A
    # After the entry: the fallback, from its first item.
    assert s.current(man, t("2026-11-08T12:00:01Z"), True, have)["item"]["m"] == A


def test_sequencer_skips_missing_media_and_unsynced_clock_plays_fallback():
    man = m()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    assert s.current(man, start + 1, True, {B})["item"]["m"] == B
    assert s.current(man, start + 1, False, {A, B})["entry"] is None
    assert Sequencer().current(man, start + 1, True, set())["item"] is None
