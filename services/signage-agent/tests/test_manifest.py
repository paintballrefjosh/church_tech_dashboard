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


def _edited(man, items, key="p1~new"):
    """The manifest a re-compile gives after the playlist was edited: a new key, and the entry now starts when it was compiled."""
    out = json.loads(json.dumps(man))
    out["playlists"] = {**man["playlists"], key: items}
    out["timeline"] = [{**man["timeline"][0], "start": "2026-11-08T10:00:05Z", "playlist": key}]
    return out


def test_an_edited_playlist_waits_for_the_cycle_to_finish():
    C = "c" * 64
    man = m()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    have = {A, B, C}
    assert s.current(man, start + 1, True, have)["item"]["m"] == A
    # Edited while A is on: A, then B (the old cycle) finish; only then does the new list begin.
    new = _edited(man, [{"m": C, "dur": 8, "kind": "image"}, {"m": A, "dur": 8, "kind": "image"}])
    assert s.current(new, start + 5, True, have)["item"]["m"] == A
    assert s.current(new, start + 9, True, have)["item"]["m"] == B
    assert s.current(new, start + 19, True, have)["item"]["m"] == B
    assert s.current(new, start + 21, True, have)["item"]["m"] == C
    assert s.current(new, start + 29, True, have)["item"]["m"] == A


def test_an_edit_does_not_send_the_show_back_to_its_first_item():
    man = m()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    assert s.current(man, start + 1, True, {A, B})["item"]["m"] == A
    assert s.current(man, start + 9, True, {A, B})["item"]["m"] == B
    again = _edited(man, man["playlists"]["p1~x"])
    assert s.current(again, start + 10, True, {A, B})["item"]["m"] == B


def test_an_item_removed_from_the_pi_is_not_held_on_for():
    man = m()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    assert s.current(man, start + 1, True, {A, B})["item"]["m"] == A
    assert s.current(man, start + 9, True, {A, B})["item"]["m"] == B
    assert s.current(man, start + 10, True, {A})["item"]["m"] == A


def test_a_different_playlist_or_schedule_starts_from_its_first_item():
    man = m()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    assert s.current(man, start + 1, True, {A, B})["item"]["m"] == A
    assert s.current(man, start + 9, True, {A, B})["item"]["m"] == B
    other = json.loads(json.dumps(man))
    other["playlists"]["p2~z"] = [{"m": A, "dur": 8, "kind": "image"}, {"m": B, "dur": 12, "kind": "video"}]
    other["timeline"][0]["playlist"] = "p2~z"
    assert s.current(other, start + 10, True, {A, B})["item"]["m"] == A


def _three():
    C = "c" * 64
    man = m()
    man["playlists"]["p1~x"] = [{"m": A, "dur": 8, "kind": "image"}, {"m": B, "dur": 8, "kind": "image"}, {"m": C, "dur": 8, "kind": "image"}]
    return man, {A, B, C}, C


def test_a_stalled_loop_moves_on_one_item_and_never_skips_the_next():
    # 2026-11-11: a CEC check held the loop up ~9 s; the picture before stayed up 16 s and the next one never showed.
    man, have, C = _three()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    assert s.current(man, start + 1, True, have)["item"]["m"] == A
    assert s.current(man, start + 7.5, True, have)["item"]["m"] == A
    # The loop comes back 9 s late, after B's whole slot: B shows now, for its full 8 s, and C follows.
    assert s.current(man, start + 17, True, have)["item"]["m"] == B
    assert s.current(man, start + 24.5, True, have)["item"]["m"] == B
    assert s.current(man, start + 25, True, have)["item"]["m"] == C


def test_on_time_ticks_keep_the_wall_clock():
    man, have, C = _three()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    seen = []
    x = start
    while x < start + 48:
        seen.append((round(x - start, 1), s.current(man, x, True, have)["item"]["m"][0]))
        x += 0.5
    changes = [(at, k) for i, (at, k) in enumerate(seen) if i == 0 or seen[i - 1][1] != k]
    assert changes == [(0.0, "a"), (8.0, "b"), (16.0, "c"), (24.0, "a"), (32.0, "b"), (40.0, "c")]


def test_a_long_gap_catches_up_with_the_clock():
    man, have, C = _three()
    s = Sequencer()
    start = t("2026-11-08T10:00:00Z")
    assert s.current(man, start + 1, True, have)["item"]["m"] == A
    # Stopped for ten minutes: 600 s = 25 cycles of 24 s, so A again, as if it had played all along.
    assert s.current(man, start + 601, True, have)["item"]["m"] == A
    assert s.current(man, start + 609, True, have)["item"]["m"] == B
