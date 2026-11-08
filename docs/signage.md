# Signage (plan)

Status: **plan, building** (2026-11-08). No Raspberry Pi is on hand yet, so everything is built and tested against a simulated
Pi (section 12) and the whole module is to be tested top to bottom on real hardware once it arrives. The first draft (another session, written without the repo) had a custom Pi image
that called home. Decided with Josh on 2026-11-08:

- **Pis run stock Raspberry Pi OS Lite**, flashed with Raspberry Pi Imager (user, password, SSH and Wi-Fi set in Imager's
  OS customisation). There is no custom image and no file to copy onto the card.
- **The dashboard finds them** (subnet scan, IP list, or continuous discovery) **and does all the setup over SSH**: packages,
  the agent, keys, the SSH lock-down, display and TV settings. After that it manages them over SSH only. A Pi never contacts
  the dashboard.
- **How tightly each Pi is locked down is a Signage admin setting** (section 6), applied and checked by the dashboard.
- No release signing. Identify shows a distinct code on each chosen TV. Media files in backups are opt-in.

Kept from the first draft: mpv players, a 14-day manifest compiled on the server and run on the Pi, Roku ECP / HDMI-CEC, and
playback (including power times) that carries on while Wi-Fi or the dashboard is down.

Out of scope for v1: IR control, web-page/live-data content, audio, synchronised playback across screens, transitions other
than hard cuts, an approval workflow, Google Drive sync.

## 1. Shape

```
  browser --session--> web --> api  /api/v1/signage/*   (module tiers; audited)
                                |   ClusterJobs: signage-discover, signage-setup, signage-media, signage-compile,
                                |                signage-sync, signage-poll, signage-watch, signage-prune
                                +-- DB (signage_* tables)   +-- Garage: signage/... keys
                                |
                                | SSH :22 (sshExec: host key pinned; setup password once, then the dashboard key)
                                v
  Pi, stock Pi OS Lite (TV/Pi VLAN): signage-agent (player, TV control, housekeeping; no listener)
                                        --ECP :8060 / CEC--> its own TV
  Pi --apt--> Debian / Raspberry Pi package mirrors (setup and OS updates only)
  api --ECP :8060--> Roku           (only when the Pi cannot be reached)
```

SSH code is reused from infra (`apps/api/src/infra/collectors/ssh.ts`: `sshExec`, key or password, trust-on-first-use host-key
pinning) and the sudo handling of infra update runs (`sudo-access.ts`). Pi OS gives Imager's user passwordless sudo, so
normally no sudo password is needed; when one is, the same terminal-style dialog is shown.

## 2. Finding Pis

Devices > "Find Pis" has three sources; all of them feed one list of **found, not set up** Pis.

- **Scan a subnet**: an IPAM subnet or a typed CIDR (at most a /22), once.
- **IP addresses**: one or more typed addresses.
- **Continuous discovery**: per subnet, a switch and an interval (15 min to 24 h, default 1 h), run by the `signage-discover`
  job. A Pi found for the first time is highlighted as **New** in the list and in the Devices page's attention count until an
  admin sets it up or dismisses it (a dismissed Pi stays hidden unless its host key changes). Optionally a notice
  (`signage.pi_found`, not urgent) to the Signage admins.

**Recognising a Pi from another VLAN.** The dashboard cannot see MAC addresses across a router, and a stock Pi's SSH banner is
plain Debian. A candidate is any address with TCP 22 open, ranked by evidence shown beside it:

1. its MAC (from the UniFi client list, the Cisco ARP cache or IPAM) has a Raspberry Pi OUI (`B8:27:EB`, `DC:A6:32`, `E4:5F:01`,
   `28:CD:C1`, `D8:3A:DD`, `2C:CF:67`, `88:A2:9E`): "Raspberry Pi (by MAC)";
2. its name (UniFi, reverse DNS, NetBIOS) looks like Imager's default or a pattern the admin sets (`signage.discover_name_pattern`,
   e.g. `tv-*`): "name matches";
3. otherwise "SSH, Debian": listed under "Other SSH hosts", collapsed.

Discovery never logs in. It only connects to port 22 and reads the banner and host key. Passwords are tried only when an admin
presses **Set up**. A known host key seen at a new address updates that device's IP.

**Identify before setup**: "Show a code" on a found Pi logs in with the setup credentials and prints a large code on the TV's
console (tty1). It installs nothing. That confirms which TV a found Pi is behind before it is named.

## 3. Setup (the dashboard's provisioning run)

**Set up** asks for a name, a screen (new or existing) and the login. Every Pi is flashed with the same Imager user and
password, so the login is normally the saved default (`signage.setup_username` / `signage.setup_password`, a `secret` setting,
under Security settings) and Set up needs no typing; a login typed for one Pi overrides it. It then runs a
**setup run** shown like an infra update run (live log, status, kept as history): idempotent steps, each skipped when already
done, so "Apply again" is safe and is also how a changed setting reaches a Pi.

1. **Check**: Raspberry Pi model (`/proc/device-tree/model`), OS release (supported list, section 10), 64-bit, free space,
   sudo works, time is synced. Stop with a clear message otherwise.
2. **Pin the host key** and record serial and MACs.
3. **Packages**: `apt-get install` mpv, python3 and the agent's Python dependencies (from Debian packages where they exist),
   v4l-utils (`cec-ctl`), iw. Needs the Pi to reach the package mirrors.
4. **Agent**: the dashboard pushes the current agent release (tarball + SHA-256) to `/opt/signage/agent/<version>/`, the
   `signage-ctl` command, the systemd units (agent + rollback watchdog), the data folder `/var/lib/signage`.
5. **System**: hostname = device name (optional), time zone = `site.timezone`, NTP server, boot to console with no login prompt
   on tty1, screen blanking off, HDMI hot-plug forced so a Pi booted with the TV off still drives it, CEC on, Wi-Fi power saving
   off.
6. **SSH lock-down** per the Signage settings (section 6), applied safely (below).
7. **Read-only root** (overlayfs) if the setting is on, then reboot.
8. **Verify**: log in again with the dashboard key, `signage-ctl status`, player running, and every lock-down setting read back
   (`sshd -T`). The device becomes **active** only after this step passes.

**Never lock the dashboard out.** SSH changes are written to `/etc/ssh/sshd_config.d/50-church-signage.conf` (dashboard key
first, then the config), checked with `sshd -t`, and reloaded with the current session still open. A **second** session is then
opened with the dashboard key and the new rules. Only if that works is the change kept and the setup password locked (if the
setting says so). If the second login fails, the file is put back and the run fails with the reason. The same applies to the
Pi firewall: the rules load with a 2-minute automatic undo that the second login cancels.

## 4. Identify

Select one Pi, several, or "all", and press Identify. Each selected Pi gets its **own** three-digit code, unique within the
batch, shown full-screen over playback for 60 s (10 s to 5 min) with its current name underneath. The Devices list shows the
same codes beside each row; rename the device or move it to another screen there. "Hide codes" ends it early. A Pi that does
not answer shows "unreachable" instead of a code.

## 5. The Devices page and "needs attention"

Tabs: **Needs attention** (default when not empty), **All**, **Found** (not set up), **Disabled**. Each problem is a badge with
the reason in words and the action beside it:

| Problem | Action |
|---|---|
| New Pi found (continuous discovery) | Set up, Show a code, Dismiss |
| Offline (no answer for 5 min while its screen should be on; alert `signage.device_offline`) | details, last seen, TV power by ECP if a Roku |
| Setup failed / not finished | the run's log, Apply again |
| Settings not applied (lock-down or system settings differ from the Signage settings) | Apply again |
| Host key changed | Trust new host key (refused logins until then) |
| Content behind (manifest or media not synced for over an hour) | Sync now, see what is missing |
| TV not responding (ECP/CEC failing) | `tv state`, `diag` |
| Under-voltage or throttled, disk under 15%, clock not synced, temperature over 80 C | `diag` |
| Agent out of date | Update |
| OS updates pending for more than 30 days | Update now |

The Screens page and the Monitoring/home summaries use the same rules (pure `deviceProblems` in `packages/shared/src/signage/`,
unit-tested).

## 6. Security settings (Signage admin)

Every setting below is chosen by a Signage admin on the module's own **Security settings** page (`/signage/security`, stored
in the `signage` settings category, `signage:admin` to read or change). **All of the module's settings are reached from the
module's own pages** (`/signage/settings`, with Security settings as one of its pages), never from Admin > Settings: you stay
within the module for everything (decided 2026-11-08; the other modules are to be moved the same way later). Applied by setup and by "Apply again"; checked on every poll (drift = "Settings not applied"). Defaults in brackets.

| Setting | What it does on the Pi |
|---|---|
| Login account [dedicated `signage`] | `dedicated`: create `signage` with a sudoers rule for exactly the agent's helpers. `setup`: keep using Imager's account |
| Lock the setup account's password [on] | `passwd -l` on Imager's user once the dashboard key works (the account stays for local console use only if the next one is off) |
| Password login over SSH [off] | `PasswordAuthentication no`, `KbdInteractiveAuthentication no` |
| Root login over SSH [off] | `PermitRootLogin no` |
| Only these accounts may log in [on] | `AllowUsers <login account>` |
| Only the dashboard may connect [on] | `from=` on the key and a `Match` block; the list is learned from `SSH_CONNECTION` on each node's logins plus `signage.ssh_from` (CIDRs) |
| Restrict the dashboard key to signage commands [on] | `command="signage-ctl",restrict` on the key; setup steps and OS updates then go through `signage-ctl` subcommands too |
| Pi firewall [off] | nftables: allow SSH only from the dashboard list, drop other inbound |
| Read-only root (overlayfs) [on] | protects the SD card from power pulls; OS updates lift it in their window |
| OS update window [Tue 02:00-04:00] | the agent lifts the overlay, reboots, `apt-get upgrade`, restores, reboots, reports |
| Dashboard-managed Wi-Fi [off] | adds Wi-Fi networks through NetworkManager (`nmcli`) |
| NTP server [the gateway] | systemd-timesyncd |

**The dashboard's key** is one Ed25519 pair for the whole site, derived from `AUTH_SECRET` and a generation number
(`signage.ssh_key_generation`), like the VAPID keys, so every node agrees and nothing is stored. "Rotate key" adds generation
N+1 on every reachable Pi, switches, then removes N. A Pi missed by a rotation shows "key out of date" and is fixed on its next
answer. A restore under a different `AUTH_SECRET` loses access to every Pi; recovery is "Set up" again with the setup login
(or re-flashing, if the setup password was locked).

The Security overview gets checks for the risky choices: password login on, root login on, "only the dashboard" off, an
unrestricted key, a saved setup password, Pis found but not set up for over a week.

## 7. `signage-ctl` (the only thing the dashboard key runs once restricted)

Reads `SSH_ORIGINAL_COMMAND`, accepts only its own subcommands with validated arguments, never runs a shell:
`hello`, `status`, `media-list`, `media-put <sha256> <offset>` (stdin, resumable, hash-checked), `manifest-put` (stdin),
`identify <code> <seconds> [label]` / `identify off`, `screenshot`, `logs <lines>`, `tv power on|off`, `tv input <name>`,
`tv state`, `restart-player`, `restart-agent`, `reboot`, `diag`, `config get|set` (closed key list), `agent-put <version>
<sha256>` (stdin), `apply <settings JSON>` (the setup steps and lock-down, from a closed schema; this is how "Apply again"
works once the key is restricted), `os-update`, `key add|remove`. Size caps on every stdin.

## 8. Data model (one migration per phase, additive)

- `signage_media`: `sha256` of the **rendition**, `kind`, `original_name`, `mime`, `width`, `height`, `duration_s`,
  `size_bytes`, `status` `uploaded|processing|ready|failed|missing`, `storage_key`, `thumb_key`, `claimed_until`, `error`,
  `created_by`.
- `signage_playlists`, `signage_playlist_items` (`position`, `duration_s`, `enabled`, `valid_from`, `valid_until`).
- `signage_screens`: `name`, `location_id`, `orientation`, `width`/`height`, `tv_control` `roku_ecp|cec|none`, `roku_ip`,
  `roku_serial`, `hdmi_input`, `fallback_playlist_id`, `manifest_dirty_at`, `enabled`.
- `signage_groups` + `signage_screen_groups` (shown as **screen groups**).
- `signage_schedules`, `signage_overrides`, `signage_power_schedules` (`days_of_week` jsonb, wall-clock on `site.timezone`).
- `signage_devices`: `screen_id`, `name`, `ip`, `ssh_port`, `known_host_key`, `login_user`, `key_generation`, `serial`, `model`,
  `os_release`, `mac_wlan`, `mac_eth`, `agent_version`, `applied_settings_hash`, `manifest_version_applied`, `last_seen_at`,
  `last_error`, latest status values, `claimed_until`, `enabled`, `status` `setting_up|active|failed|disabled`.
- `signage_discovery_subnets` (`cidr` or `ipam_subnet_id`, `continuous`, `interval_min`, `last_run_at`).
- `signage_found` (`ip`, `host_key`, `banner`, `evidence`, `first_seen_at`, `last_seen_at`, `dismissed_at`).
- `signage_setup_runs` (`device_id`, `kind` `setup|apply|os_update|agent_update`, `status`, `output`, `started_by`, times).
- `signage_status_samples` (7 days), `signage_manifests` (last 5 per screen), `signage_screenshots`, `signage_agent_releases`.

No commands table: a command is a synchronous SSH call from the request, recorded by the audit interceptor; background runs
are recorded in `signage_setup_runs`, as `dns_sync_runs` does for DNS. No password is stored except the optional saved setup
password (encrypted `secret` setting).

**Backups**: configuration tables and devices are `data` (status columns `volatile`); found Pis, samples, manifests,
screenshots and setup runs are `skip`. **Media files are opt-in** (a box on each schedule and on "Back up now", off by default,
with the size shown). `isSafeFileKey` is widened to `signage/media/` and `signage/releases/`. A media row whose object is
missing after a restore becomes `missing` ("upload again"), and the compiler leaves its items out with a warning.

## 9. Server: routes, jobs, compiler

**Access**: module `signage` (Church Apps menu). user `signage:read:any` (see screens, schedule, media); moderator
`signage:write:any` (media, playlists, schedules, events, power schedules); admin `signage:admin` (discovery, setup, identify,
devices, commands, lock-down settings, agent releases, all TVs off/on). A new non-system group `signage` with Signage
moderator, created by the migration only if the name is free; no existing group is granted anything. Equipment routes are
`@OperationalOnly`. MCP: reads plus create/update for playlists, schedules and events; discovery, setup, devices, commands and
uploads are `excluded` in `route-rules.ts`.

**Routes** `/api/v1/signage/*`: media (upload `@SessionOnly`, 500 MiB, streamed to S3, typed by ffprobe), playlists (+ reorder),
screens, screen groups, schedules, events (+ "End now"), power schedules (+ all off/on), `preview?at=`, `timeline?from&to`,
discovery (subnets, scan now, add IPs, found list, dismiss, show code), devices (set up, apply again, rename, assign, identify,
commands, screenshot, logs, trust new host key, remove), setup runs, key (show public key, rotate), agent releases (upload,
current, roll out). The setup password is never logged (`redactKeys`; the audit scrubber hides `password` too).

**Jobs** (all `ClusterJobs`, claimed where per-device, restore gate respected):
`signage-discover` (each continuous subnet on its interval, one scan at a time via `acquireMutex`, 16 connects at once, 1 s);
`signage-setup` (runs queued setup/apply/update runs, one per device, CLAIMED, progress written as it goes so another node can
show it); `signage-media` (ffprobe + ffmpeg as livestreams runs it: argument array, empty environment, time limit, `/tmp`;
H.264 High at most 1080p30 8 Mbps, no audio, `+faststart`; images resized, metadata stripped); `signage-compile` (dirty screens
every 5 s, all screens nightly at 03:00 site time); `signage-sync` (pushes missing media and the manifest over one SSH session,
resumable; files over 50 MB in the 00:00-05:00 window unless needed within 24 h); `signage-poll` (60 s: status, settings
drift, samples); `signage-watch` (offline and attention alerts, baselines in `job_state`, silenced by maintenance mode);
`signage-prune` (samples 7 d, setup runs 90 d, unreferenced media 30 d, found rows 30 d after last seen, manifests beyond 5).

**Compiler** (pure, `packages/shared/src/signage/compile.ts`): at any instant an active event (highest priority first, then
the most specific target: screen, screen group, all; then the newest, so an "all screens" emergency event at top priority wins), then a schedule on the screen, then on its screen groups (ties to the lowest
id, warned in the UI), then the fallback playlist, then a built-in logo slide. Disabled or out-of-window items dropped, an
empty playlist falls through, power resolves the same way (an event changes power only with `force_power_on`). Contiguous
timeline, a playlist restarts at each entry, a video's time loops or cuts it, `media` lists every hash in the window. Unit
tests: overrides vs screen vs group, ties, midnight crossings, both DST changes, item windows, empty playlists, power.

**ECP fallback**: `tv power`/`tv input` on a Roku screen whose Pi does not answer go from the API to the Roku (5 s, private
address only).

## 10. On the Pi

`signage-agent` (Python 3, systemd `Restart=always`, `WatchdogSec=60`), installed by setup. No network listener. Loops: the
**player** (mpv on DRM/KMS, `--hwdec` per model, items advanced on the agent's own timer, portrait by rotation, logo slide when
nothing is cached, overlays for identify codes); **TV control** (power entries at their times, retried until the TV reports the
state; input on power-on; drivers `roku_ecp` and `cec`, CEC as a backup on a Roku TV; SSDP finds the Roku on the Pi's segment);
**housekeeping** (old media removed after 7 days, sooner under 15% free). Until the clock is synced it plays the fallback and
skips power actions. Agent updates: hash-checked tarball, `current` symlink, rollback by a watchdog unit if the new agent is not
healthy within 120 s. Code in `services/signage-agent/` (Python, `pytest` in a container), outside the Node workspace.

**Supported**: Raspberry Pi 3B+, 4 and 5 (bought on price), Raspberry Pi OS Lite 64-bit, **latest release only**
(`SIGNAGE_SUPPORTED_OS`: Debian 13 "trixie" based, read from `/etc/os-release`). Setup refuses anything else with the reason;
a new Pi OS release is added to that list once it has been tried.

**Resolution**: v1 assumes every TV is 1080p. Videos are made at 1080p30 and images at 1920x1080 (portrait: 1080x1920), once,
shared by every screen.

**Later (lower priority): per-screen resolution.** `signage_screens.width/height` exist from the start and are reported in
`status` (the mode KMS chose), but are not used yet. The improvement: renditions per resolution (`signage_media_renditions`,
keyed by media + size; the manifest names the rendition for that screen), 4K images on a 4K TV, 720p for weak TVs, and a
warning when a screen's mode differs from what it is set to. Videos stay at most 1080p on Pi 3/4 (no 4K H.264 decode).

## 11. Network

The dashboard and the Pis/TVs are on different VLANs, with these allowed (or the path fully open): API nodes -> Pis TCP 22;
API nodes -> Rokus TCP 8060 (fallback); Pis -> NTP. **The Pis have full internet access** (confirmed 2026-11-08), which setup
and OS updates need for the package mirrors; Rokus need it for their own updates. MAC addresses for recognising Pis come from
UniFi (where the TV/Pi VLAN is expected to live) or the Cisco ARP cache, whichever sees them. DHCP reservations for every Pi and TV. The device page separates "Pi unreachable" from "Roku
unreachable".

## 12. Phases

**Build order (2026-11-08):** with no Pi on hand, all phases are built now, in that order, as separate commits, against the
simulated Pi; the hardware acceptance checks below are then run together, top to bottom, once a Pi arrives (TV brands and
models are recorded then). Until then the module is "built, untested on hardware".

Each ends with a demo on real hardware: **one Roku TV and one non-Roku (CEC) TV** (both available). Every phase ships unit
tests, database integration tests on CockroachDB and YugabyteDB, and smoke/e2e cases that never touch a real device. The
dashboard's tests run against a **fake Pi**: a Debian container with sshd, a Pi-like `/proc/device-tree/model`, and the real
`signage-ctl` and agent with a stub player.

1. **Playback on a Pi from a hand-written manifest** (agent only, installed by hand): 3 images at 8 s + 1 video at 18 s loop on
   each Pi model bought; 1080p30 H.264 with no dropped frames; a timeline switch within 2 s.
2. **Discovery and setup**: migration, module, `signage` group, settings; scan / IPs / continuous discovery with New
   highlighting; show a code; the setup run with every step, the lock-down settings and the no-lockout rule; identify;
   the Devices page with attention. Acceptance: a freshly flashed stock Pi goes from found to active with no keyboard;
   every lock-down setting applied and read back; a deliberately broken sshd setting is rolled back and the Pi stays
   reachable; the restricted key cannot open a shell, forward a port or use SFTP (fake Pi).
3. **Content**: media upload and transcoding, playlists, screens, screen groups, schedules, events, the compiler with preview
   and timeline, sync. Acceptance: the resolution tests; Wi-Fi pulled mid-copy resumes and never shows a partial file; the
   dashboard down for 24 h and the screen keeps its schedule; a playlist edit on the TV within 30 s.
4. **TV control**: ECP and CEC drivers, power schedules, input, state, SSDP, the ECP fallback. Acceptance: scheduled on/off on
   the Roku TV after 12 h in standby (note whether the CEC backup was needed); on/off and input on the CEC TV; a change made
   with the physical remote shown in the UI within 60 s.
5. **Fleet care**: screenshots, status charts, alerts, agent updates with rollback, OS update window, key rotation, read-only
   root. Acceptance: a broken agent release rolls back within 3 min; 20 power pulls during playback leave it bootable and
   playing; with two nodes (`tests/cluster/sim.sh`) discovery, setup, sync and commands work from either node and nothing runs
   twice.
6. **Pilot and rollout**: 3 screens for two Sundays, then all. A staff member who is not the builder schedules a one-off event
   for a screen group from the UI. Runbook here: flashing with Imager, Roku and CEC TV settings, setting up and identifying,
   replacing a Pi, common failures.

Pages: Screens, Screen detail, Media library, Playlists, Schedules (week calendar, events on top, tie warnings), Events,
Devices (attention / all / found / disabled; discovery; setup runs), Power, Settings (lock-down). Light and dark, 390 px, axe
clean.

## 13. Decisions (2026-11-08)

1. Stock Raspberry Pi OS Lite flashed with Imager; the dashboard discovers Pis and does all setup over SSH.
2. Lock-down (account, password/root login, allowed accounts and sources, restricted key, firewall, read-only root, update
   window, Wi-Fi, NTP) is configurable by Signage admins, applied and checked by the dashboard.
3. Discovery by subnet scan, IP list, or continuous discovery per subnet that highlights new Pis.
4. The Devices page shows offline Pis and everything else that needs attention.
5. No release signing; agent updates are hash-checked over the pinned SSH connection.
6. Identify works on one, several or all, each TV showing its own code.
7. Media files in backups are opt-in.
8. Pi 3B+, 4 or 5 depending on price; fewer than 30 screens.
9. Different VLANs, the needed ports open.
10. A new `signage` group holds Signage moderator.
11. Tested on a Roku TV and a non-Roku TV (brands recorded when testing starts).
12. The Pis have full internet access. Latest Raspberry Pi OS only. One saved setup login for every Pi.
13. Security settings live on the module's own page, for Signage admins.
14. 1080p everywhere in v1; per-screen resolution is a later, lower-priority improvement.
15. Everything is built now against a simulated Pi and tested on hardware afterwards.
16. From the first draft: portrait supported, all muted, no approval workflow, an "all screens" emergency event at top
    priority, Wi-Fi by default with Ethernet also working.
