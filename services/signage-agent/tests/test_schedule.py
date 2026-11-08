from datetime import datetime

import pytest

from signage_agent import schedule


def test_window_and_midnight():
    w = schedule.parse("Tue 02:00-04:00; Sat 22:00-02:00")
    assert schedule.active(w, datetime(2026, 11, 10, 3, 0))  # Tuesday
    assert not schedule.active(w, datetime(2026, 11, 10, 4, 0))
    assert schedule.active(w, datetime(2026, 11, 14, 23, 0))  # Saturday
    assert schedule.active(w, datetime(2026, 11, 15, 1, 0))  # Sunday morning, from Saturday's window
    assert not schedule.active(w, datetime(2026, 11, 16, 1, 0))


def test_day_ranges_and_errors():
    w = schedule.parse("Mon-Fri 09:00-17:00")
    assert schedule.active(w, datetime(2026, 11, 13, 10, 0))
    assert not schedule.active(w, datetime(2026, 11, 14, 10, 0))
    assert schedule.parse("") == []
    with pytest.raises(ValueError):
        schedule.parse("Funday 09:00-10:00")
