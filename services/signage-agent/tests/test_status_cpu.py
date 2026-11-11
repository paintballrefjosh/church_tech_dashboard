"""CPU use: from /proc/stat, averaged since the previous status read."""

import json
import time

from signage_agent import paths, status


def _stat(tmp, busy, idle):
    # user nice system idle iowait irq softirq steal
    (tmp / "proc").mkdir(exist_ok=True)
    (tmp / "proc" / "stat").write_text(f"cpu  {busy} 0 0 {idle} 0 0 0 0 0 0\ncpu0 1 2 3\n")


def _setup(monkeypatch, tmp_path):
    monkeypatch.setattr(paths, "ROOT", str(tmp_path))
    monkeypatch.setattr(paths, "CPU_SAMPLE", str(tmp_path / "run" / "cpu.json"))


def test_the_times_are_busy_and_total_with_iowait_counted_idle(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    (tmp_path / "proc").mkdir()
    (tmp_path / "proc" / "stat").write_text("cpu  100 10 40 800 50 5 5 0 99 0\n")
    assert status._cpu_times() == (160, 1010)


def test_since_the_previous_read(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    (tmp_path / "run").mkdir()
    (tmp_path / "run" / "cpu.json").write_text(json.dumps({"at": time.time() - 60, "busy": 100, "total": 1000}))
    _stat(tmp_path, 400, 1600)  # +300 busy of +1000 total
    assert status.cpu_percent() == 30.0


def test_a_first_read_samples_for_a_moment(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _stat(tmp_path, 100, 900)
    calls = []

    def fake_sleep(s):
        calls.append(s)
        _stat(tmp_path, 150, 950)  # +50 busy of +100

    monkeypatch.setattr(status.time, "sleep", fake_sleep)
    assert status.cpu_percent() == 50.0
    assert calls == [0.5]


def test_no_proc_stat_is_unknown_not_a_crash(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    assert status.cpu_percent() is None
