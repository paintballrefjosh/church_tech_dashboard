"""The adoption screen: which step the TV names while the dashboard sets the Pi up."""

import json

from signage_agent import adoption, paths, player


def test_every_step_the_setup_announces_has_a_line():
    from signage_agent import apply

    announced = [n for n, _ in adoption.STEPS]
    assert announced == ["check", "packages", "accounts", "agent", "system", "lockdown", "overlay", "done"]
    assert hasattr(apply, "Log")


def test_progress_counts_from_one_and_names_the_step():
    assert adoption.progress({"step": "agent", "at": 100.0}, 110.0) == (4, 8, "Starting the agent")
    assert adoption.progress({"step": "check", "at": 100.0}, 100.0) == (1, 8, "Checking the Pi")


def test_progress_is_none_for_a_stale_unknown_or_missing_note():
    assert adoption.progress(None, 1.0) is None
    assert adoption.progress({"step": "nope", "at": 1.0}, 2.0) is None
    assert adoption.progress({"step": "agent"}, 2.0) is None
    assert adoption.progress({"step": "system", "at": 100.0}, 100.0 + adoption.STALE_S + 1) is None
    assert adoption.progress({"step": "system", "at": 100.0}, 90.0) is None  # a clock that went backwards


def test_the_last_step_is_shown_only_briefly():
    assert adoption.progress({"step": "done", "at": 100.0}, 100.0 + adoption.FINISH_SHOW_S - 1) is not None
    assert adoption.progress({"step": "done", "at": 100.0}, 100.0 + adoption.FINISH_SHOW_S + 1) is None


def test_note_writes_the_step_and_ignores_unknown_names(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "RUN", str(tmp_path))
    monkeypatch.setattr(paths, "ADOPTING", str(tmp_path / "adopting.json"))
    adoption.note("bogus")
    assert not (tmp_path / "adopting.json").exists()
    adoption.note("lockdown")
    assert json.loads((tmp_path / "adopting.json").read_text())["step"] == "lockdown"


def test_note_never_fails_the_setup(monkeypatch):
    monkeypatch.setattr(paths, "RUN", "/proc/nonexistent/x")
    monkeypatch.setattr(paths, "ADOPTING", "/proc/nonexistent/x/a.json")
    adoption.note("check")


def test_the_screen_says_adopting_the_step_and_the_count():
    ass = player.adopting_ass(5, 8, "Setting the name, time and display")
    assert "Adopting Pi..." in ass
    assert "Setting the name, time and display" in ass
    assert "Step 5 of 8" in ass
