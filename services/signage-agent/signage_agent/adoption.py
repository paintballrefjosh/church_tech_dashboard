"""What the TV says while the dashboard adopts the Pi: "Adopting Pi...", the step it is on and "Step 4 of 8".

`apply` (the setup steps) calls `note` as each step starts; the player reads the note (`progress`) and draws it, but ONLY on a Pi
that has no manifest yet. A Pi that already plays content is re-applied without a word on the screen. The player itself only
exists from the "agent" step on, so the first three steps are not seen on a brand new Pi."""

import os
import time
from typing import Dict, List, Optional, Tuple

from . import paths
from .util import write_json

# (apply step name, what the person reads). The last one is the dashboard's own check of the Pi after the agent is done.
STEPS: List[Tuple[str, str]] = [
    ("check", "Checking the Pi"),
    ("packages", "Installing the player software"),
    ("accounts", "Creating the accounts"),
    ("agent", "Starting the agent"),
    ("system", "Setting the name, time and display"),
    ("lockdown", "Securing remote access"),
    ("overlay", "Protecting the SD card"),
    ("done", "Finishing up"),
]
STALE_S = 20 * 60  # a step can be long (installing packages); a note older than this is a setup that died
FINISH_SHOW_S = 180  # "Finishing up" is shown this long; the content normally arrives well before


def note(step: str) -> None:
    """Record the step that is starting. Best effort: the screen is never worth failing a setup for."""
    if step not in [s for s, _ in STEPS]:
        return
    try:
        os.makedirs(paths.RUN, exist_ok=True)
        write_json(paths.ADOPTING, {"step": step, "at": time.time()})
    except OSError:
        pass


def progress(state: Optional[Dict], now: float) -> Optional[Tuple[int, int, str]]:
    """(step number, step count, words) while an adoption is under way, else None."""
    if not isinstance(state, dict):
        return None
    names = [s for s, _ in STEPS]
    step, at = state.get("step"), state.get("at")
    if step not in names or not isinstance(at, (int, float)):
        return None
    age = now - at
    if age < 0 or age > STALE_S or (step == "done" and age > FINISH_SHOW_S):
        return None
    i = names.index(step)
    return i + 1, len(STEPS), STEPS[i][1]
