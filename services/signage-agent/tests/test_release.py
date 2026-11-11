import json
import os
import sys
import tempfile

ROOT = tempfile.mkdtemp(prefix="signage-root-")
os.environ["SIGNAGE_ROOT"] = ROOT
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from signage_agent import apply, paths, release

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDASHBOARDKEYBODY lampstand"
OWN = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPERSONALKEYBODY me@laptop"


def test_only_the_dashboards_key_lines_are_removed():
    text = f'from="10.0.0.5",command="/usr/local/bin/signage-ctl",restrict {KEY}\n{OWN}\n'
    assert release.without_keys(text, [KEY]) == OWN + "\n"


def test_nothing_left_when_only_the_dashboards_key_was_there():
    assert release.without_keys(KEY + "\n", [KEY]).strip() == ""


def test_the_boot_options_setup_added_are_taken_out_and_the_rest_kept():
    line = "console=serial0,115200 root=PARTUUID=abc rootwait quiet consoleblank=0 vt.global_cursor_default=0 video=HDMI-A-1:1920x1080@60D\n"
    assert release.strip_boot_tokens(line) == "console=serial0,115200 root=PARTUUID=abc rootwait quiet\n"


def test_a_user_set_video_option_is_not_ours():
    assert "video=HDMI-A-2:1280x720@60" in release.strip_boot_tokens("quiet video=HDMI-A-2:1280x720@60\n")


def test_the_original_is_remembered_once(monkeypatch):
    os.makedirs(os.path.dirname(paths.CMDLINE), exist_ok=True)
    os.makedirs(paths.p("/etc"), exist_ok=True)
    with open(paths.CMDLINE, "w") as f:
        f.write("console=tty1 quiet splash\n")
    with open(paths.p("/etc/hostname"), "w") as f:
        f.write("tv1-pi\n")
    apply.remember_original({"desktop": True})
    first = json.load(open(paths.ORIGINAL))
    assert first["desktop"] is True and first["hostname"] == "tv1-pi" and first["cmdline"] == "console=tty1 quiet splash\n"
    with open(paths.p("/etc/hostname"), "w") as f:
        f.write("changed\n")
    apply.remember_original({"desktop": False})
    assert json.load(open(paths.ORIGINAL)) == first


def test_release_with_no_read_only_root_runs_now():
    assert release.start() == {"started": True, "runNow": True, "reboots": True, "bootId": ""}  # no /proc here
    assert release.resume_after_boot() is False  # only the "after-boot" phase resumes


def test_a_pending_release_resumes_after_the_boot():
    paths_state = paths.RELEASE_STATE
    with open(paths_state, "w") as f:
        json.dump({"phase": "after-boot"}, f)
    assert release.resume_after_boot() is True


def test_a_full_release_puts_the_pi_back(monkeypatch):
    open(paths.SIMULATED, "w").close()  # no systemd, no real accounts: the file work is what is checked here
    calls = []
    monkeypatch.setattr(release, "run", lambda args, *a, **k: (calls.append(list(args)) or (0, "", "")))
    home = paths.p("/home/pi")
    os.makedirs(os.path.join(home, ".ssh"), exist_ok=True)
    with open(paths.p("/etc/passwd"), "w") as f:
        f.write(f"pi:x:1000:1000::{'/home/pi'}:/bin/bash\n")
    ak = os.path.join(home, ".ssh", "authorized_keys")
    with open(ak, "w") as f:
        f.write(f'restrict {KEY}\n{OWN}\n')
    os.makedirs(paths.DATA, exist_ok=True)
    os.makedirs(paths.OPT, exist_ok=True)
    os.makedirs(os.path.dirname(paths.SSHD_DROPIN), exist_ok=True)
    open(paths.SSHD_DROPIN, "w").write("PasswordAuthentication no\n")
    with open(paths.APPLIED, "w") as f:
        json.dump({"config": {"setupUser": "pi", "loginAccount": "setup", "authorizedKeys": [KEY]}}, f)
    with open(paths.ORIGINAL, "w") as f:
        json.dump({"desktop": False, "hostname": "tv1-pi", "cmdline": "console=tty1 quiet\n"}, f)
    with open(paths.CMDLINE, "w") as f:
        f.write("console=tty1 quiet consoleblank=0\n")
    done = release.run_release()
    assert not os.path.exists(paths.SSHD_DROPIN)
    assert open(ak).read() == OWN + "\n"
    assert open(paths.CMDLINE).read() == "console=tty1 quiet\n"
    assert not os.path.exists(paths.OPT) and not os.path.exists(paths.DATA)
    assert ["passwd", "-u", "pi"] in calls
    assert done[-1] == "restarting"


# ------------------------------------------------------------------ the read-only root: the note must survive the restart

from signage_agent import util


def _overlay_on(monkeypatch):
    """/proc/mounts with raspi-config's overlay: the real root at /media/root-ro."""
    os.makedirs(paths.p("/proc"), exist_ok=True)
    with open(paths.p("/proc/mounts"), "w") as f:
        f.write(f"overlayroot / overlay rw 0 0\n/dev/mmcblk0p2 {paths.OVERLAY_LOWER} ext4 ro 0 0\n")
    monkeypatch.setattr(util, "run", lambda *a, **k: (0, "", ""))
    monkeypatch.setattr(release, "have", lambda prog: True)


def _overlay_off():
    try:
        os.unlink(paths.p("/proc/mounts"))
    except FileNotFoundError:
        pass


def test_with_the_read_only_root_on_the_note_is_also_written_to_the_sd_card(monkeypatch):
    if os.path.exists(paths.SIMULATED):
        os.unlink(paths.SIMULATED)
    _overlay_on(monkeypatch)
    raspi = []
    monkeypatch.setattr(release, "run", lambda args, *a, **k: (raspi.append(list(args)) or (0, "", "")))
    try:
        r = release.start()
        assert r["started"] is True and r["runNow"] is False
        assert ["raspi-config", "nonint", "disable_overlayfs"] in raspi
        lower = paths.OVERLAY_LOWER + paths.RELEASE_STATE[len(paths.ROOT):]
        assert json.load(open(lower))["phase"] == "after-boot"  # what the next boot reads
    finally:
        _overlay_off()


def test_after_the_restart_the_note_on_the_sd_card_carries_the_reset_on(monkeypatch):
    with open(paths.RELEASE_STATE, "w") as f:
        json.dump({"phase": "after-boot", "bootId": "before"}, f)
    assert release.resume_after_boot() is True


def test_a_read_only_root_still_on_after_the_restart_does_not_resume_and_says_so(monkeypatch):
    with open(paths.RELEASE_STATE, "w") as f:
        json.dump({"phase": "after-boot", "bootId": "before"}, f)
    _overlay_on(monkeypatch)
    try:
        assert release.resume_after_boot() is False
        p = release.progress()
        assert p["readOnlyRoot"] is True and p["phase"] == "after-boot" and p["startedBootId"] == "before"
        assert any("still on" in line for line in p["log"])
    finally:
        _overlay_off()
