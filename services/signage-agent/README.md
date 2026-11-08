# signage-agent

The program the church dashboard installs on each signage Raspberry Pi (docs/signage.md section 10). Python 3 from the
OS, no extra Python packages. The dashboard pushes it over SSH (setup, "Update agent") from the copy in its API image.

- `bin/signage-ctl`: the dashboard's commands over SSH (closed list, JSON out).
- `bin/signage-agent`: the daemon (`signage-agent.service`): mpv player, TV control (Roku ECP, HDMI-CEC), media tidying,
  OS updates in their window. No network listener.
- `systemd/`: the units setup installs.

Tests: `tests/signage/agent-tests.sh` (pytest in a container). The end-to-end check against a simulated Pi is
`tests/signage/fake-pi.sh`. Bump `VERSION` with every change: the dashboard rolls out a release when its version differs.
