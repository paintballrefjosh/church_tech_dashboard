from signage_agent import apply


def test_a_pi_that_boots_to_the_desktop_is_recognised(monkeypatch):
    monkeypatch.setattr(apply, "run", lambda *_a, **_k: (0, "graphical.target\n", ""))
    assert apply.desktop_image() is True


def test_lite_boots_to_the_console(monkeypatch):
    monkeypatch.setattr(apply, "run", lambda *_a, **_k: (0, "multi-user.target\n", ""))
    assert apply.desktop_image() is False


def test_no_systemd_or_a_failed_call_is_not_a_desktop(monkeypatch):
    monkeypatch.setattr(apply, "run", lambda *_a, **_k: (127, "", "systemctl: not found"))
    assert apply.desktop_image() is False


# ------------------------------------------------------------------ the read-only root at setup

import os
import shutil

import pytest

from signage_agent import paths


def _fake_pi(monkeypatch, overlay: bool, root_free_mb: int, sd_free_mb: int):
    monkeypatch.setattr(apply, "model", lambda: "Raspberry Pi 4 Model B Rev 1.5")
    monkeypatch.setattr(apply, "os_release", lambda: {"VERSION_CODENAME": apply.SUPPORTED_CODENAMES[0], "PRETTY_NAME": "Raspberry Pi OS"})
    monkeypatch.setattr(apply, "desktop_image", lambda: False)
    monkeypatch.setattr(apply, "remember_original", lambda facts: None)
    monkeypatch.setattr(apply, "overlay_active", lambda: overlay)
    monkeypatch.setattr(apply.os, "uname", lambda: os.uname_result(("Linux", "pi", "6.6", "#1", "aarch64")))

    def usage(path):
        free = sd_free_mb if path == paths.OVERLAY_LOWER else root_free_mb
        return shutil._ntuple_diskusage(32 * 1024 * 1048576, 0, free * 1048576)

    monkeypatch.setattr(apply.shutil, "disk_usage", usage)


def test_a_read_only_root_setup_did_not_turn_on_is_refused(monkeypatch):
    if os.path.exists(paths.APPLIED):
        os.unlink(paths.APPLIED)
    _fake_pi(monkeypatch, overlay=True, root_free_mb=451, sd_free_mb=20_000)
    with pytest.raises(apply.ApplyError, match="read-only root"):
        apply.check(apply.Log())


def test_a_pi_set_up_with_the_read_only_root_counts_the_sd_card_not_the_ram_overlay(monkeypatch):
    os.makedirs(os.path.dirname(paths.APPLIED), exist_ok=True)
    open(paths.APPLIED, "w").write("{}")
    try:
        _fake_pi(monkeypatch, overlay=True, root_free_mb=451, sd_free_mb=20_000)
        log = apply.Log()
        apply.check(log)
        assert any("20000 MB free" in line for line in log.lines)
    finally:
        os.unlink(paths.APPLIED)


def test_a_full_sd_card_is_still_refused(monkeypatch):
    _fake_pi(monkeypatch, overlay=False, root_free_mb=451, sd_free_mb=451)
    with pytest.raises(apply.ApplyError, match="Only 451 MB free"):
        apply.check(apply.Log())
