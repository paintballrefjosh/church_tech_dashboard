"""Applying settings to a Pi whose read-only root (overlay) is on: what is written through to the real root must also
belong to the right user, and a re-apply must not rewrite the boot options for nothing."""

import os

from signage_agent import apply, paths


def test_chown_targets_without_the_overlay_is_the_file_itself(monkeypatch):
    monkeypatch.setattr(apply, "overlay_active", lambda: False)
    assert apply.chown_targets("/home/signage/.ssh/authorized_keys") == ["/home/signage/.ssh/authorized_keys"]


def test_chown_targets_with_the_overlay_adds_the_copy_on_the_real_root(monkeypatch):
    monkeypatch.setattr(apply, "overlay_active", lambda: True)
    monkeypatch.setattr(paths, "ROOT", "")
    got = apply.chown_targets("/home/signage/.ssh/authorized_keys")
    assert got == ["/home/signage/.ssh/authorized_keys", paths.OVERLAY_LOWER + "/home/signage/.ssh/authorized_keys"]


def test_the_real_root_copy_is_given_to_the_user_too(monkeypatch, tmp_path):
    """The bug: write_file made the real-root copy as root, sshd refused it after the restart (StrictModes)."""
    monkeypatch.setattr(apply, "overlay_active", lambda: True)
    monkeypatch.setattr(paths, "ROOT", "")
    lower = tmp_path / "ro"
    monkeypatch.setattr(paths, "OVERLAY_LOWER", str(lower))
    live = tmp_path / "home" / "signage" / ".ssh"
    live.mkdir(parents=True)
    (live / "authorized_keys").write_text("k\n")
    under = lower / str(live).lstrip("/")
    under.mkdir(parents=True)
    (under / "authorized_keys").write_text("k\n")
    calls = []
    monkeypatch.setattr(apply.shutil, "chown", lambda p, u, g=None: calls.append((str(p), u, g)))
    ran = []
    monkeypatch.setattr(apply, "run", lambda cmd, **_k: ran.append(cmd) or (0, "", ""))
    apply._chown("signage", str(live / "authorized_keys"))
    assert calls == [(str(live / "authorized_keys"), "signage", "signage"), (str(under / "authorized_keys"), "signage", "signage")]
    assert ["mount", "-o", "remount,rw", str(lower)] in ran


def test_a_copy_that_is_not_there_underneath_is_skipped(monkeypatch, tmp_path):
    monkeypatch.setattr(apply, "overlay_active", lambda: True)
    monkeypatch.setattr(paths, "ROOT", "")
    monkeypatch.setattr(paths, "OVERLAY_LOWER", str(tmp_path / "ro"))
    f = tmp_path / "file"
    f.write_text("x")
    calls = []
    monkeypatch.setattr(apply.shutil, "chown", lambda p, u, g=None: calls.append(str(p)))
    monkeypatch.setattr(apply, "run", lambda *_a, **_k: (0, "", ""))
    apply._chown("signage", str(f))
    assert calls == [str(f)]


def test_boot_options_already_there_are_left_where_they_are(monkeypatch):
    """raspi-config's overlay appends its own option after `quiet`; moving ours past it made every apply rewrite the file
    (and restart the Pi)."""
    os.makedirs(os.path.dirname(paths.CMDLINE), exist_ok=True)
    line = "console=tty1 root=PARTUUID=abc rootwait quiet consoleblank=0 vt.global_cursor_default=0 overlayroot=tmpfs video=HDMI-A-1:1920x1080@60D\n"
    with open(paths.CMDLINE, "w") as f:
        f.write(line)
    monkeypatch.setattr(apply, "have", lambda _c: False)
    log = apply.Log()
    c = {"hostname": "", "timezone": "UTC", "ntpServer": ""}
    assert apply.system(c, log) is False
    assert open(paths.CMDLINE).read() == line
    assert not any("boot options" in m for m in log.lines)


def test_missing_boot_options_are_added_once(monkeypatch):
    with open(paths.CMDLINE, "w") as f:
        f.write("console=tty1 root=PARTUUID=abc rootwait\n")
    monkeypatch.setattr(apply, "have", lambda _c: False)
    c = {"hostname": "", "timezone": "UTC", "ntpServer": ""}
    assert apply.system(c, apply.Log()) is True
    first = open(paths.CMDLINE).read()
    for tok in ("quiet", "consoleblank=0", "vt.global_cursor_default=0", "video=HDMI-A-1:1920x1080@60D"):
        assert tok in first.split()
    assert apply.system(c, apply.Log()) is False
    assert open(paths.CMDLINE).read() == first
