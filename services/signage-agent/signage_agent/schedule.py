"""Weekly windows like "Tue 02:00-04:00; Sat 22:00-02:00" (packages/shared/src/monitor-schedule.ts), on local time."""

import re
from datetime import datetime
from typing import List, Tuple

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
Window = Tuple[List[int], int, int]


def _day(name: str) -> int:
    n = name.strip()[:3].lower()
    if n not in DAYS:
        raise ValueError(f'"{name.strip()}" is not a day')
    return DAYS.index(n) + 1


def _clock(s: str) -> int:
    m = re.match(r"^([01]?\d|2[0-3]):([0-5]\d)$", s.strip())
    if not m:
        raise ValueError(f'"{s.strip()}" is not a time')
    return int(m.group(1)) * 60 + int(m.group(2))


def parse(text: str) -> List[Window]:
    out: List[Window] = []
    for raw in re.split(r"[;\n]", text or ""):
        part = raw.strip()
        if not part:
            continue
        m = re.match(r"^(\S+)\s+(\S+)\s*-\s*(\S+)$", part)
        if not m:
            raise ValueError(f'"{part}" should look like "Sun 08:00-13:00"')
        days = set()
        for d in m.group(1).split(","):
            r = d.split("-")
            if len(r) == 2:
                a, b = _day(r[0]), _day(r[1])
                for _ in range(7):
                    days.add(a)
                    if a == b:
                        break
                    a = a % 7 + 1
            else:
                days.add(_day(d))
        start, end = _clock(m.group(2)), _clock(m.group(3))
        if start == end:
            raise ValueError(f'"{part}" starts and ends at the same time')
        out.append((sorted(days), start, end))
    return out


def active(windows: List[Window], now: datetime) -> bool:
    """Is local time `now` inside a window? A window crossing midnight belongs to the day it starts on."""
    wd = now.isoweekday()
    minute = now.hour * 60 + now.minute
    prev = 7 if wd == 1 else wd - 1
    for days, start, end in windows:
        if start < end:
            if wd in days and start <= minute < end:
                return True
        else:
            if wd in days and minute >= start:
                return True
            if prev in days and minute < end:
                return True
    return False
