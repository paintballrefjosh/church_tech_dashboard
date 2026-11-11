import base64
import hashlib
import io
import json
import os

import pytest

from signage_agent import ctl, media, paths


def test_media_put_resumes_and_checks_the_hash():
    data = os.urandom(300_000)
    sha = hashlib.sha256(data).hexdigest()
    r = media.put(sha, 0, len(data), io.BytesIO(data[:100_000]))
    assert r == {"have": 100_000, "done": False}
    assert media.listing()["partial"][sha] == 100_000
    r = media.put(sha, 100_000, len(data), io.BytesIO(data[100_000:]))
    assert r == {"have": len(data), "done": True}
    assert media.listing()["media"][sha] == len(data)
    # Already here: nothing to send.
    assert media.put(sha, 0, len(data), io.BytesIO(b""))["done"]


def test_media_put_refuses_bad_bytes_and_offsets():
    sha = "0" * 64
    with pytest.raises(media.MediaError):
        media.put(sha, 0, 3, io.BytesIO(b"abc"))
    assert sha not in media.listing()["partial"]
    with pytest.raises(media.MediaError):
        media.put(sha, 10, 20, io.BytesIO(b""))
    with pytest.raises(media.MediaError):
        media.put("../../x", 0, 1, io.BytesIO(b"a"))


def test_parse_forced_command():
    assert ctl.parse([], {"SSH_ORIGINAL_COMMAND": "signage-ctl status"}) == ("status", [], True)
    assert ctl.parse([], {"SSH_ORIGINAL_COMMAND": ""}) == ("hello", [], True)
    assert ctl.parse(["media-put", "a"], {}) == ("media-put", ["a"], False)
    for evil in ("status; reboot", "status $(id)", "status `id`", "status > /etc/passwd", "status|sh"):
        with pytest.raises(ctl.Refused):
            ctl.parse([], {"SSH_ORIGINAL_COMMAND": evil})


def run_ctl(capsys, argv, env=None, stdin=b""):
    old = dict(os.environ)
    os.environ.update(env or {})
    import sys

    sys.stdin = io.TextIOWrapper(io.BytesIO(stdin))
    try:
        with pytest.raises(SystemExit) as e:
            ctl.main(argv)
    finally:
        os.environ.clear()
        os.environ.update(old)
    return e.value.code, json.loads(capsys.readouterr().out)


def test_internal_commands_are_not_reachable_over_ssh(capsys):
    code, out = run_ctl(capsys, [], {"SSH_ORIGINAL_COMMAND": "revert-after 0123456789abcdef 0"})
    assert code == 2 and "unknown command" in out["error"]
    code, out = run_ctl(capsys, [], {"SSH_ORIGINAL_COMMAND": "bash"})
    assert code == 2


def test_identify_writes_the_overlay_file(capsys):
    label = base64.urlsafe_b64encode("Foyer TV".encode()).decode().rstrip("=")
    code, out = run_ctl(capsys, ["identify", "042", "60", label])
    assert code == 0 and out["identify"] == "042"
    with open(paths.IDENTIFY) as f:
        assert json.load(f)["label"] == "Foyer TV"
    code, out = run_ctl(capsys, ["identify", "42", "60"])
    assert code == 2
    code, out = run_ctl(capsys, ["identify", "off"])
    assert code == 0 and not os.path.exists(paths.IDENTIFY)


def test_manifest_put_refuses_garbage_and_older_versions(capsys):
    from test_manifest import m

    code, out = run_ctl(capsys, ["manifest-put"], stdin=b"not json")
    assert code == 2
    code, out = run_ctl(capsys, ["manifest-put"], stdin=json.dumps(m(version=5)).encode())
    assert code == 0 and out["manifestVersion"] == 5 and len(out["missingMedia"]) == 2
    code, out = run_ctl(capsys, ["manifest-put"], stdin=json.dumps(m(version=4)).encode())
    assert out == {"manifestVersion": 5, "kept": "newer"}


def test_agent_put_checks_the_hash(capsys):
    code, out = run_ctl(capsys, ["agent-put", "1.2.3", "0" * 64], stdin=b"x")
    assert code == 2 and "sha256" in out["error"]


def test_config_closed_keys(capsys):
    code, out = run_ctl(capsys, ["config", "set", "hwdec", "no"])
    assert code == 0 and out["config"]["hwdec"] == "no"
    code, out = run_ctl(capsys, ["config", "set", "hwdec", "v4l2m2m-copy"])
    assert code == 0 and out["config"]["hwdec"] == "v4l2m2m-copy"
    # "default" removes the override: the agent picks by model again.
    code, out = run_ctl(capsys, ["config", "set", "hwdec", "default"])
    assert code == 0 and "hwdec" not in out["config"]
    code, out = run_ctl(capsys, ["config", "set", "anything", "x"])
    assert code == 2
