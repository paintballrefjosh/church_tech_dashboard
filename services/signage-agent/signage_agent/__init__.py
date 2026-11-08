"""The church dashboard's signage agent for Raspberry Pi OS (docs/signage.md section 10).

It has no network listener: the dashboard reaches the Pi over SSH only and runs `signage-ctl`. The daemon
(`signage-agent`) plays the manifest, drives the TV and keeps the media folder tidy.
"""

import os

_HERE = os.path.dirname(os.path.abspath(__file__))


def version() -> str:
    try:
        with open(os.path.join(os.path.dirname(_HERE), "VERSION"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "0.0.0"
