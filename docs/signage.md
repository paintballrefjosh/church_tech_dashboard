# Signage

Status: **built, untested on hardware** (2026-11-08). No Raspberry Pi is on hand yet, so everything was built and tested against
simulated Pis (section 0) and the whole module is to be tested top to bottom on real hardware once it arrives (section 12). The first draft (another session, written without the repo) had a custom Pi image
that called home. Decided with Josh on 2026-11-08:

- **Pis run stock Raspberry Pi OS Lite**, flashed with Raspberry Pi Imager (user, password, SSH and Wi-Fi set in Imager's
  OS customisation). There is no custom image and no file to copy onto the card. Lite is under **Raspberry Pi OS (other)** in
  Imager. The full desktop image also works: the player is mpv on DRM/KMS and needs the screen to itself, so setup switches a
  desktop Pi to boot to the console (`systemctl set-default multi-user.target`, then the reboot). Not yet tried on hardware.
- **The dashboard finds them** (subnet scan, IP list, or continuous discovery) **and does all the setup over SSH**: packages,
  the agent, keys, the SSH lock-down, display and TV settings. After that it manages them over SSH only. A Pi never contacts
  the dashboard.
- **How tightly each Pi is locked down is a Signage admin setting** (section 6), applied and checked by the dashboard.
- No release signing. Identify shows a distinct code on each chosen TV. Media files in backups are opt-in.

Kept from the first draft: mpv players, a 14-day manifest compiled on the server and run on the Pi, Roku ECP / HDMI-CEC, and
playback (including power times) that carries on while Wi-Fi or the dashboard is down.

Out of scope for v1: IR control, web-page/live-data content, audio (planned: section 10, "sound from videos"), synchronised playback across screens, transitions other
than hard cuts, an approval workflow, Google Drive sync.


**Naming: "Adopt" (2026-11-11).** The page calls taking a Pi under management **Adopt** (as UniFi does): the Found tab's button,
"Adopt again", the "Adopting" and "Adoption failed" states and the run kind. The code, routes, database values and the settings still
say `setup` (`POST /signage/setup`, run kind `setup`, status `setting_up`, `signage.setup_username`/`setup_password`, the "setup login"
being the account made in Imager); where this document says "setup" or "Set up", the page says Adopt.

## 0. What is built and what was checked (2026-11-08)

Built: every phase in section 12 (agent, discovery, setup and lock-down, content, compiler, sync, TV control, power, fleet care, the
pages, Security overview checks, opt-in media in backups). Pages: Screens, a screen's page, Schedule (one-time and repeating entries in one month calendar, since 2026-11-11), Playlists, Media, Power,
Devices (Needs attention / All / Found / Disabled, discovery, setup runs with the sudo prompt, identify) and a device's page, Settings
and Security settings (inside the module, section 6).

Also in the rest of the app: global search finds screens (by name, room, group and notes), playlists (by name, description and what
they play; never one-off ad hoc playlists) and media files, for anyone with Signage read access; nothing about a Pi is indexed. The
home page's Systems view (and the Front of House meters) shows a **Screens** row, for Signage readers on an install with a Pi set up:
Pis set up and switched on, and the ones the offline watch has judged offline, each linking to its screen's page; the meter also says
how many one-time schedule entries (notices, events) are on now.

Checked:
- Unit tests: the compiler and its resolution rules, device problems, settings, the SSH key, the agent bundle, helpers; the agent's
  own pytest suite.
- `apps/api/test/signage.integration.test.ts` on CockroachDB 24.2 and YugabyteDB 2024.2: compile versions, the dirty flag, the
  preview order, that one setup run and one uploaded file are claimed by one node, and the search documents (no device, no
  address, no one-off playlist). The home page's Screens row: `home-sections.test.ts`.
- `tests/signage/fake-pi.sh`: two Debian trixie containers with sshd, sudo and nftables, driven through the real API. Discovery by
  address, setup with the saved login, every lock-down check read back, password login refused afterwards, apply again, the firewall
  setting on and off (and a second container blocked by it), identify, diagnostics, status, sync of a manifest, a Pi that needs a sudo
  password, key rotation.
- Smoke (`tests/smoke/signage.mjs`) and the browser test (`signage.spec.ts`), plus the accessibility sweep over every page.

Not checked (needs hardware, section 12): mpv playback and frame drops, HDMI-CEC, Roku ECP and SSDP, the real Pi OS image (Imager
user, `raspi-config`, `vcgencmd`, read-only root, Wi-Fi), OS updates against the real mirrors, power pulls, a broken agent release
rolling back on a Pi, and discovery across VLANs. Two dashboard nodes (`tests/cluster/sim.sh`) were not run with signage; the claims
are covered by the integration test only.

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

The **Find Pis** button at the top of the Devices page (and on the Signage screens page) opens a panel above the tabs, whatever tab is
showing. It opens by itself while there are no devices yet and on the Found tab. It has three sources; all of them feed one list of
**found, not set up** Pis (the Found tab).

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
   **The name shown for a found Pi (and offered at Set up) is the name the Pi reports itself** (2026-11-11): the host name it sent when it
   asked for its address (UniFi's `hostname`), else reverse DNS; never the UniFi alias, which belongs to the hardware address and
   survives a re-flash (a Pi re-imaged as `pi-tv1` was still listed as `tv1-pi`). The alias and NetBIOS name still count when
   RECOGNISING a Pi. Discovery never logs in, so a Pi that sent no host name has none shown; type one at Set up (which then writes it to the
   Pi). When the UniFi client list was read and a Pi reports no name, or its host key changed, the old name is dropped, not kept.
3. its SSH banner is this dashboard's own setup banner: "Set up by this dashboard before";
4. otherwise it is not listed as a Pi: a known MAC that is not a Pi's ("Not a Raspberry Pi network card": a VM, a NAS) or a plain
   Debian/other banner. These go under **Other SSH hosts**, a collapsed section of the Found tab: not counted, never marked New,
   never announced (`isLikelyPi`). A Pi on a USB network adapter lands there and can still be set up by hand from it.

**Known equipment is never listed.** A scan skips, and removes any row for, an address the dashboard already knows as other
equipment: a subnet's gateway (IPAM), a Cisco switch, a UniFi device or a monitored infra host. An address typed into "Or add
addresses" is the exception: the admin said it is a Pi, so it is checked and listed.

Discovery never logs in. It only connects to port 22 and reads the banner and host key. Passwords are tried only when an admin
presses **Set up**. A known host key seen at a new address updates that device's IP.

**Identify before setup**: "Show a code" on a found Pi logs in with the setup credentials and prints a large code on the TV's
console (tty1). It installs nothing. That confirms which TV a found Pi is behind before it is named. A Pi that boots to the
desktop shows the desktop, not tty1, so for it the code is followed by `chvt 1` and checked with `fgconsole`; Ctrl+Alt+F7 or a
restart brings the desktop back. **The code is taken off the screen when the "Show a code" window is closed** (`POST /signage/discovery/found/:id/clear-code`, `SignageDiscovery.clearCode`, 2026-11-11): an adopted Pi gets `identify off`; any other Pi has its tty1 reset and the screen given back (a desktop Pi is switched to the console it was on, which `show-code` reads with `fgconsole` before switching and the window sends back as `vt`, 7 when unknown; a Lite Pi has its login prompt started again). It signs in again with the same login, so a password typed for one Pi stays in that window (never saved) until it is closed. If the clear fails, the code also ends when the Pi restarts or is set up.

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
   on tty1 (a Pi that boots to the desktop is switched to the console here, with a reboot), screen blanking off, HDMI hot-plug forced so a Pi booted with the TV off still drives it, CEC on, Wi-Fi power saving
   off.
6. **SSH lock-down** per the Signage settings (section 6), applied safely (below).
7. **Read-only root** (overlayfs) if the setting is on, then reboot.
8. **Verify**: log in again with the dashboard key, `signage-ctl status`, player running, and every lock-down setting read back
   (`sshd -T`). The device becomes **active** only after this step passes.

**Never lock the dashboard out.** SSH changes are written to `/etc/ssh/sshd_config.d/50-lampstand-signage.conf` (dashboard key
first, then the config), checked with `sshd -t`, and reloaded with the current session still open. A **second** session is then
opened with the dashboard key and the new rules. Only if that works is the change kept and the setup password locked (if the
setting says so). If the second login fails, the file is put back and the run fails with the reason. The same applies to the
Pi firewall: the rules load with a 2-minute automatic undo that the second login cancels.

## 4. Identify

Select one Pi, several, or "all", and press Identify. Each selected Pi gets its **own** three-digit code, unique within the
batch, shown full-screen over playback for 60 s (10 s to 5 min) with its current name underneath. The Devices list shows the
same codes beside each row; rename the device or move it to another screen there. "Hide codes" ends it early. A Pi that does
not answer shows "unreachable" instead of a code.

### The device page's maintenance buttons explain themselves (2026-11-11)

The three buttons that are easy to confuse, in the last row of "Do something" on `/signage/devices/<id>`, show a tooltip on hover and on
keyboard focus (`components/hover-tip.tsx`; the texts are `APPLY_TIP`, `AGENT_TIP` and `SETUP_AGAIN_TIP` at the top of the page file, and
must stay true to the code). What each does:

| Button | Run kind | What happens |
|---|---|---|
| **Apply settings again** | `apply` (`SetupService.runApply`) | Signs in with the dashboard's key and applies the current Security and system settings (login account, SSH rules, firewall, read-only root, Wi-Fi, time server, OS update window), after bringing the agent up to date only if it is behind. Content is not touched; the Pi restarts only when a boot setting needs it. Two logins: if the second fails, the Pi puts its SSH settings back within 2 minutes. |
| **Update the agent** | `agent_update` (`pushAgent`, forced) | Copies the agent release this dashboard carries (hash-checked), switches `current` to it and restarts the agent, even when the Pi already reports that version. The watchdog returns to the previous version if the new one is not healthy within 120 s. Settings and content are not touched. |
| **Set up again** | `setup` (`runSetup`) | The whole first setup from the start (check, packages, accounts, agent, key, Security settings), with a form for the name, screen and an optional login for this Pi. A Pi the dashboard's key still opens repeats through that key with no password; otherwise the saved setup login (or the one typed) is used. The only one of the three that is available while the Pi is not working. |

The tooltip is wired with `aria-describedby`, is dismissed with Escape, and hangs off a wrapper so a disabled button still shows it. It is drawn in a portal on `document.body` (a card's `backdrop-filter` made it a stacking context, so an inline tip went behind the next card), opens below the button and flips above it when the viewport has no room underneath, and carries a "More in the Signage guide" link to `/signage/guide#device-buttons` (mouse only; the Guide tab is the keyboard route).

### The in-app guide (2026-11-11)

The module has a **Guide** tab (`/signage/guide`, `apps/web/src/app/signage/guide/page.tsx`), inside the module like everything else: what Signage
does, quick start, setting up a Pi, day to day, the device page buttons, troubleshooting by badge, and a settings reference. It is written for the
people who run the module; **this file stays the design record**, so when behaviour changes, change both. Rules: (1) the guide is JSX, built from
`components/guide.tsx` (`GuidePage`, `GuideSection`, `Steps`, `Troubleshooting`, `SettingsReference`), so it ships in the web image and every node
shows the same text; (2) **the settings tables are rendered from `KNOWN_SETTINGS`** (`SIGNAGE_SECURITY_KEYS`, `SIGNAGE_GENERAL_KEYS`), never
retyped; (3) the parts only a Signage admin can use (quick start, provisioning, device buttons, settings) are left out for everyone else, judged from
`GET /me` permissions; (4) it says plainly that nothing has run on real Pis yet. The tab shows for any Signage reader; the palette has "Signage guide".

### Forgetting a Pi resets it (agent 1.1.0)

**Forget** on a device page takes the Pi back to a normal Raspberry Pi first (`DELETE /signage/devices/:id`; `?reset=0` skips the
reset). The dashboard brings the agent up to date (an older one has no `release`), then runs `signage-ctl release`, which returns at
once. On the Pi: the first user's password is unlocked again (setup only ran `passwd -l`, so the original password works), the
dashboard's key lines (other keys in `authorized_keys` are kept), the SSH drop-in and the firewall are removed, the `signage` and
player accounts and the sudoers rule are deleted, the agent units, `/opt/signage` and `/var/lib/signage` (media, manifest) go, the
console-only boot is undone (tty1 login back; `graphical.target` and desktop autologin again when the Pi was a desktop image) and
the boot options setup added are removed. Kept: the Wi-Fi connection (NetworkManager is never touched), the installed packages,
the host name and time zone as they were before setup. With the read-only root on nothing written now would survive a restart, so
phase one lifts it (`disable_overlayfs`, restart) and phase two (`release-run`, started by the agent at the next boot from
`release.json`) does the work and restarts again. What the Pi looked like before the first setup is `original.json`, written once
by `check` (agent 1.1.0 and later; a Pi set up earlier falls back to "a desktop was installed" for the boot target and to removing
only the boot options setup adds). A Pi the dashboard cannot reach is not forgotten, because it would be left locked to the key:
the page offers "forget anyway". The log of phase two is `/var/tmp/lampstand-signage-release.log` on the Pi. Not tested on a real Pi.

**Forget waits to see the reset finish (agent 1.1.2, 2026-11-11).** The first real Forget (tv1-pi, read-only root on) left the Pi
locked down with its overlay still on, and the dashboard had already deleted the row, so nothing listed the Pi and only the
dashboard's key could open it; the person had to re-flash it. Why it stopped was never found (the card was re-flashed): either the
`after-boot` note did not survive the restart (it relied on `signage-data.service` bind-mounting `/var/lib/signage` from the SD
card, which has not run on hardware) or `disable_overlayfs` did not take. Since then: (1) the note is written `durable` (also to the
real root under the overlay, whatever the bind mount does; the OS-update note too). (2) The device is not deleted at once: it becomes
`resetting` (screen released) and a `forget` run checks the Pi every 15 s until the dashboard's key is REFUSED, which is the reset's
last change, and only then deletes the row. While the key still opens the Pi, `signage-ctl release-status` (phase, boot id at the
start and now, read-only root, the last 20 lines of the release log) goes through the pure `forgetVerdict`: restarted with no note,
or restarted with the read-only root still on, stops at once; anything else after `FORGET_WAIT_MS` (15 min). Stopping makes the
device `failed` with `FORGET_FAILED_PREFIX` ("Reset failed" in the list), the Pi's log in the run, and Forget can be tried again
(or forgotten without a reset). (3) Setup refuses a Pi whose read-only root is on unless setup itself turned it on
(`applied.json` exists), with how to turn it off, and counts free space on the SD card (`/media/root-ro`), not the RAM overlay,
which on a 1 GB Pi reads about 450 MB ("Only 451 MB free on the SD card" was this).

### Deleting a screen (2026-11-11)

A screen page has a **Delete** button beside Edit (Signage admins; `DELETE /signage/screens/:id`, audited `signage.screen.delete`, which always
existed: only the button was missing). It asks first and says what goes with the screen: its own schedules, events and power times
(`ContentService.deleteScreen`); playlists and media are kept. A Pi that drove the screen stays set up (`signage_devices.screen_id` is
`ON DELETE SET NULL`) and keeps playing its last content until it is given another screen on its device page.

### Apply settings again on a Pi with the read-only root on (agent 1.1.4, 2026-11-11)

**What went wrong.** The first re-apply on a real Pi (tv1-pi, read-only root on) ended with the dashboard's key refused for good: the run said
"SSH settings kept", the Pi restarted, and every login with the key (all key generations) failed; the Pi's password login for `pi` was locked
by setup, so nothing could get in. **Cause:** with the overlay on, `write_file` writes a system file twice, to the live (RAM) root and through
to the real root under `/media/root-ro` (`_write`, run as root), so that the change survives the restart. A file made that way belongs to
root, and `_chown(login, authorized_keys)` only changed the live copy. After the restart sshd looked at the real copy, owned by root and
not by `signage`, and refused it (StrictModes: "bad ownership"). Setup never showed it because it writes before the overlay is switched
on, to the real root. **Fix:** `_chown` also changes the copy under `/media/root-ro` (`chown_targets`), tests in `tests/test_apply_overlay.py`.
Also: the boot options step no longer moves a token that is already in `cmdline.txt` (raspi-config's `overlayroot=` follows `quiet`, and
moving ours past it made every apply rewrite the file and restart the Pi for nothing).

**Recovering a Pi that is already locked out** (agent older than 1.1.4, apply run with the overlay on): take out the SD card, on its root
partition give the account its files back: find the numeric id of `signage` in `/etc/passwd`, then `chown <id>:<id> home/signage/.ssh
home/signage/.ssh/authorized_keys`. Or re-flash and set up again. **Never apply settings to a Pi with the read-only root on until it
runs 1.1.4**: Update the agent first (an apply pushes the agent itself when its version differs, before changing anything).

**Still not carried through to the real root** (they are made by commands, not `write_file`, so with the overlay on they last until the
next restart): creating an account, `passwd -l` of the setup user, `systemctl enable|mask|set-default`, `raspi-config do_boot_behaviour`.
Normal re-applies do not need them (they already happened at setup); a CHANGE that does (a different login account, turning "lock the
setup account's password" on later) needs the overlay lifted first (`disable_overlayfs`, restart, apply, turn it on again), which an apply
does not yet do on its own. The dashboard also records the settings as applied whatever the Pi managed to keep.

### The TV says which step the adoption is on (agent 1.1.5, 2026-11-11)

While a Pi with no content yet is being adopted, its TV shows "Adopting Pi...", the step's name under it and "Step N of 8", instead
of "Waiting for the dashboard". `apply.Log.step` calls `adoption.note(step)` (`signage_agent/adoption.py`), which writes the step and the
time to `/run/signage/adopting.json` (best effort: a failure never stops a setup); the player reads it in `Agent.play`
(`adoption.progress`, then `player.adopting_ass`). The eight steps are the ones setup already announces: check, packages, accounts,
agent, system, lockdown, overlay, done. **The player only exists from the "agent" step on** (that step starts `signage-agent.service`),
so a brand new Pi's screen first appears at step 4 of 8; steps 1-3 happen with a blank or console screen. The screen is shown only
while no manifest is loaded (a Pi that already plays content is re-applied silently), a note older than 20 minutes is ignored (a setup
that died must not leave the screen saying it is working), and "Finishing up" disappears after 3 minutes. The identify code still wins
over it. Not yet seen on a real TV. Tests: `tests/test_adoption.py`.

### The adoption window finishes by itself (2026-11-11)

When the adopt run succeeds, the window's Close button becomes Done and, after 10 seconds, the window closes and the device's page opens
(`SetupModal`, `AFTER_DONE_MS`). Done does it at once. Closing the window by hand first cancels the wait, so nothing navigates after the
person has left. A failed run or one that needs a sudo password keeps the window open as before.

### Editing a playlist does not restart the show (agent 1.1.6, 2026-11-11)

A new manifest used to restart the slideshow from its first item: the playlist's key in the manifest carries a hash of its content, and
the first timeline entry starts at the moment of compiling, and the `Sequencer` took either change for "a new entry". Now an entry's
identity is its source plus the playlist's own id (the part of the key before `~`). While that is the same, the cycle in progress is
finished from the list it began with, and the edited list takes over when the cycle comes round to its first item (`Sequencer.current`).
A different schedule, event, playlist or the fallback still starts from its first item. A media file taken off the Pi mid-cycle is
skipped at once (it is not held on for), and a playlist edited to hold nothing playable blanks the screen straight away. Tests:
`tests/test_manifest.py` (the `edited` cases). The agent must be updated on the Pis (Update the agent) for this to apply.

### CPU use on the device page (agent 1.1.8, 2026-11-11)

The device page's Status list has a CPU row ("37% busy") and, under the temperature bars, a bar strip of the last day's CPU use (0-100% of
the bar, amber from 70%, red from 90%). The agent reports `cpuPct` in `signage-ctl status` (`status.cpu_percent`: all cores together from
the first line of `/proc/stat`, iowait counted as idle). It is the average SINCE THE PREVIOUS STATUS READ (the reading is kept in
`/run/signage/cpu.json`), so a spike between two polls still counts; when there is no usable earlier reading (first read, over 15 minutes,
a restart) it samples for 0.5 s instead. The poller stores it with each sample (`signage_status_samples.cpu_pct`, migration 0094, additive;
older rows and older agents give none, and the strip appears once two readings exist). Tests: `tests/test_status_cpu.py`.

### A screen's page ends with its own month calendar (2026-11-11)

The bottom of a screen's page is the full month calendar of THAT screen (`ScreenCalendar`, `schedules/schedule-calendar.tsx`) where
it used to be a seven-day bar chart ("The next seven days"; the `/screens/:id/timeline` route is unchanged but the web no longer calls it). It is
the Schedule page's own calendar with the "Show" filter fixed to the screen (`entryMatches` with `screen:<id>`): the screen's entries, those
of its groups and the all-screens ones, month by month, a day panel under it, a list of days on narrow screens. Anyone with Signage
write can open an entry or add one on a day, and an entry added there starts with this screen picked as its target (`ModalStart.screenId`).
The calendar pieces (`MonthGrid`, `MonthAgenda`, `DayPanel`, `PriorityBadge`, `whenText`) moved from the Schedule page into
`schedule-calendar.tsx`, shared by both pages. The bar chart's "TV off" shading and the tie warnings are no longer on this page.

### Double click and right click on the calendar (2026-11-11)

For anyone with Signage write, on the Schedule page and a screen's own calendar: a double click on a day's box opens "Add to the schedule" for
that day (a double click on an event does not: it only opens that event, as a click does), a right click on a day's box opens a small menu
("Add to the schedule" or "Cancel") and a right click on an event opens "Edit event" or "Cancel" (`CalendarContextMenu` in
`schedules/schedule-calendar.tsx`: a portal on `document.body`, Escape, a click elsewhere, scrolling or Tab close it, arrow keys move).
Readers without write get the browser's own menu. They are shortcuts for the mouse: the day panel's "Add on this day" and an event's Edit
button do the same and are the keyboard route. Not on the phone list (no right click on touch).

### The device page asks the TV for its power state (2026-11-11)

Opening the device page of a Pi that can be reached asks the TV (through the Pi: HDMI-CEC or the Roku) whether it is on, and says so under the
TV buttons ("The TV is on." / "The TV is off (standby)."). The button for the state it is already in is disabled (TV on while it is on, TV off
while it is off). "Ask the TV" asks again; after TV on/off the page shows what was asked at once and checks what the TV says 8 seconds later.
A TV that cannot be read (CEC not answering, no TV control set on the screen) shows "not known" with the reason, and neither button is
disabled. The question is `GET /signage/devices/:id/tv` (`DevicesService.tvNow`, `@OperationalOnly`, a read: not audited, like the logs, so
opening the page does not fill the audit log; MCP-excluded by the devices rule). It makes one SSH login and one CEC/Roku query per ask, and
the page asks only on opening, not on its 15 s refresh.

### "Playing" says what is on, in words (2026-11-11)

The Pi reports only ids: the manifest's playlist key (`<playlist id>~<hash>`), the first 12 characters of the file's SHA-256 and the entry's
source (`schedule:<id>`, `fallback`, `logo`). The device page used to print those. `DevicesService.playingFor` now looks the names up for
every device it returns (three small queries: playlists by id, media by `left(sha256, 12)`, schedule entries by id) and the device carries
`playing` (`SignageDevicePlaying`); the page writes "Sunday loop: Welcome.jpg (Sunday service)", "(fallback playlist)" for the fallback, "The
logo slide" when nothing is scheduled, and says so when the playlist or the file is no longer in the library or the player is not running.
Not shown: how long until it changes (the Pi does not report it; the screen's own page does).

### A switched-off schedule entry stays on the calendar, greyed (2026-11-11)

`occurrences` (`schedules/schedule-model.ts`) no longer drops an entry whose `enabled` is false: the calendar draws it grey with a dashed edge,
its name struck through and the word "off" beside it (the day panel says "Switched off"), so it can be found and switched back on instead of
vanishing. Only the display changed: `compileManifest` and the Pis still ignore a disabled entry, as before. Test: `schedule-model.test.ts`.

## 5. The Devices page and "needs attention"

Tabs: **Needs attention** (default when not empty), **All**, **Found** (not set up), **Disabled**. The Find Pis panel (section 2) sits above them. Each problem is a badge with
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
within the module for everything (decided 2026-11-08; every other module has since been moved the same way, see [module-settings.md](module-settings.md)). Applied by setup and by "Apply again"; checked on every poll (drift = "Settings not applied"). Defaults in brackets. **The lock-down is opt-in since 2026-11-11**: the defaults were relaxed while the module is being tried on real Pis (the person must be able to log in to a Pi to troubleshoot it), so a fresh install sets up an open Pi and the Security overview reports each relaxed choice; turn them on here once the Pis behave. **With the defaults setup changes no SSH login rule on the Pi**: it adds the dashboard's key (and, with the
dedicated login account, the `signage` account and its sudoers rule); the drop-in then holds only the `VersionAddendum` banner
discovery looks for. The password and root rules were plain "allow" booleans until 2026-11-11 and were always written
(`PasswordAuthentication yes` included); they are now "refuse" switches whose off means "not written" (`null` in the apply
config). The drop-in is `10-lampstand-signage.conf`: sshd takes the first value of a keyword, and a fresh Pi's
`50-cloud-init.conf` (`PasswordAuthentication yes`) sorted before the old `50-lampstand-signage.conf` and silently won, which is
why a Pi locked down to keys only still took passwords (seen on tv1-pi as drift). The old file is removed on the next apply.

| Setting | What it does on the Pi |
|---|---|
| Login account [dedicated `signage`] | `dedicated`: create `signage` with a sudoers rule for exactly the agent's helpers. `setup`: keep using Imager's account |
| Lock the setup account's password [off] | `passwd -l` on Imager's user once the dashboard key works (the account stays for local console use only if the next one is off) |
| Refuse password logins over SSH [off] | on: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`; off: NOT WRITTEN, the Pi's own rule stays |
| Refuse root logins over SSH [off] | on: `PermitRootLogin no`; off: not written (Raspberry Pi OS: root has no password or key, and sshd's default is `prohibit-password`, so root cannot log in) |
| Only these accounts may log in [off] | `AllowUsers <login account>` |
| Only the dashboard may connect [off] | `from=` on the key and a `Match` block; the list is learned from `SSH_CONNECTION` on each node's logins plus `signage.ssh_from` (CIDRs) |
| Restrict the dashboard key to signage commands [off] | `command="signage-ctl",restrict` on the key; setup steps and OS updates then go through `signage-ctl` subcommands too |
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
works once the key is restricted), `os-update`, `release` (above), `key add|remove`. Size caps on every stdin.

## 8. Data model (one migration per phase, additive)

- `signage_media`: `sha256` of the **rendition**, `kind`, `original_name`, `mime`, `width`, `height`, `duration_s`,
  `size_bytes`, `status` `uploaded|processing|ready|failed|missing`, `storage_key`, `thumb_key`, `claimed_until`, `error`,
  `created_by`.
- `signage_playlists`, `signage_playlist_items` (`position`, `duration_s`, `enabled`, `valid_from`, `valid_until`).
- `signage_screens`: `name`, `location_id`, `orientation`, `width`/`height`, `tv_control` `roku_ecp|cec|none`, `roku_ip`,
  `roku_serial`, `hdmi_input`, `fallback_playlist_id`, `manifest_dirty_at`, `enabled`.
- `signage_groups` + `signage_screen_groups` (shown as **screen groups**).
- `signage_schedules` (one row per schedule entry: `kind` `once|weekly|monthly`; `starts_at`/`ends_at` for once; `days_of_week`
  jsonb, `month_weeks` jsonb (1-4, -1 = last), `start_time`/`end_time` wall-clock on `site.timezone` and optional
  `start_date`/`end_date` for repeats; `priority` 1-5; `force_power_on`; `target_id` null = all screens), `signage_power_schedules`.
  `signage_overrides` held the one-off events until migration 0093; the `signage-schedule-adopt` job moves any row it finds
  (also from an old backup) into `signage_schedules` with the same id, and a later release drops the table.
- `signage_devices`: `screen_id`, `name`, `ip`, `ssh_port`, `known_host_key`, `login_user`, `key_generation`, `serial`, `model`,
  `os_release`, `mac_wlan`, `mac_eth`, `agent_version`, `applied_settings_hash`, `manifest_version_applied`, `last_seen_at`,
  `last_error`, latest status values, `claimed_until`, `enabled`, `status` `setting_up|active|failed|disabled`.
- `signage_discovery_subnets` (`cidr`, `label`, `continuous`, `interval_min`, `last_run_at`, `last_found`; subnets are typed in, not linked to IPAM).
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
`signage:write:any` (media, playlists, schedule entries, power schedules); admin `signage:admin` (discovery, setup, identify,
devices, commands, lock-down settings, agent releases, all TVs off/on). A new non-system group `signage` with Signage
moderator, created by the migration only if the name is free; no existing group is granted anything. Equipment routes are
`@OperationalOnly`. MCP: reads plus create/update for playlists and schedule entries; discovery, setup, devices, commands and
uploads are `excluded` in `route-rules.ts`.

**Routes** `/api/v1/signage/*`: media (upload `@SessionOnly`, 500 MiB, streamed to S3, typed by ffprobe), playlists (+ reorder),
screens, screen groups, schedules (+ "End now" for a one-time entry), power schedules (+ all off/on), `preview?at=`, `timeline?from&to`,
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

**Schedule** (merged 2026-11-11; until then weekly "schedules" and one-off "events" were separate, events always on top). One
list of entries, each **one time** (a start and an end date and time), **weekly** (days of the week, a start and an end time,
optional first and last day) or **monthly** (the same, only in the chosen weeks of the month: first to fourth, and last; "last"
is the last seven days of the month, so the fourth and the last can be the same day). Targets: a screen, a screen group or all
screens. **Priority** is Lowest, Low, Normal, High, Highest (1-5, default Normal; the "Notice on every screen now" shortcut is
Highest with the TVs switched on). **Saving refuses a conflict** (409 naming the other entry and the first moment they meet):
two enabled entries on at the same moment, on at least one common screen (a group reaches its members, all screens every
screen), at the same priority (`signageScheduleConflicts` in `schedule-rules.ts`, pure, unit-tested; repeats are compared over
the next two years, which holds every weekday-and-week combination; what is already over is ignored). The person gives one of
them a different priority. Old rows were converted by `legacySignagePriority`: events Highest, schedules Low / Normal / High
around the old default of 100. The page is a month calendar (Sunday first, three entries per day and "N more", a panel for the
chosen day, an agenda instead of the grid on a phone) with a List view; all of it on the site's clock (`/signage/summary`
carries `timezone`). Model: `apps/web/src/app/signage/schedules/schedule-model.ts` (tested). `/signage/events` redirects.

**Compiler** (pure, `packages/shared/src/signage/compile.ts`): at any instant the schedule entries that are on and apply to the
screen, highest priority first; leftover ties (a screen that joined a group after both entries were saved, a restored backup)
go to the most specific target (screen, group, all), then the group id, then the newest, and the timeline route warns about
them. Then the fallback playlist, then a built-in logo slide. Disabled or out-of-window items dropped, an empty playlist falls
through, an entry with `force_power_on` adds its windows to the power times. Timeline sources are `schedule:<id>` (manifests
from before the merge also say `override:` and `group-schedule:`; the names still resolve). Contiguous timeline, a playlist
restarts at each entry, a video's time loops or cuts it, `media` lists every hash in the window. Unit tests: priority across
kinds and targets, ties, monthly weeks, midnight crossings, both DST changes, item windows, empty playlists, power.

**ECP fallback**: `tv power`/`tv input` on a Roku screen whose Pi does not answer go from the API to the Roku (5 s, private
address only).

## 10. On the Pi

`signage-agent` (Python 3, systemd `Restart=always`, `WatchdogSec=60`), installed by setup. No network listener. Loops: the
**player** (mpv on DRM/KMS, items advanced on the agent's own timer, portrait by rotation, logo slide when nothing is cached,
overlays for identify codes); **TV control** on its own thread (power entries at their times, retried until the TV reports the
state; input on power-on; drivers `roku_ecp` and `cec`, CEC as a backup on a Roku TV; SSDP finds the Roku on the Pi's segment);
**housekeeping** (old media removed after 7 days, sooner under 15% free). Until the clock is synced it plays the fallback and
skips power actions. Agent updates: hash-checked tarball, `current` symlink, rollback by a watchdog unit if the new agent is not
healthy within 120 s. Code in `services/signage-agent/` (Python, `pytest` in a container), outside the Node workspace.

**Timing and decoding (agent 1.1.7, 2026-11-11).** (1) *A late tick never skips an item* (`Sequencer`): a slot boundary passed by
under `LATE_TOLERANCE_S` keeps the wall clock; later than that, the next item starts NOW with its full time; only a gap of
`STALL_GAP_S` (300 s: the agent was stopped, the clock was set) catches up with the clock. Before, a stall of one slot left the
previous picture on twice as long and the next never showed (found on a Pi 3B+ after a playlist edit: a 9 s CEC check in the
playback loop). That is also why TV control left the playback loop: a CEC or Roku command can take 15 s. (2) *Hardware decoding by
model* (`player.default_hwdec`): `v4l2m2m-copy` on a Pi 3/4/CM3/CM4/400 (mpv's `auto-safe` never picks the V4L2 codec, so H.264
was decoded on the CPU: choppy 1080p, a Pi 3B+ at its soft temperature limit), `auto-safe` elsewhere (the Pi 5 has no H.264
hardware, only HEVC through `drm`). `signage-ctl config set hwdec <auto-safe|no|drm|v4l2m2m-copy|default>` overrides it per Pi;
status and `diag` report the decoder mpv actually uses (`decoder`, `hwdec`, `codecs`). **Unverified on hardware**: if mpv cannot
open the V4L2 decoder it falls back to software on its own, so read `decoder` after an update. A Pi 3 still plays 1080p H.264
at most at 30 fps, High profile level 4.1 or lower; encode signage video to that.
(3) *mpv keeps one frame in its queue* (`--swapchain-depth=1`, agent 1.1.10): on DRM a frame reaches the screen only when later
frames push it out, and a picture is drawn once, so with the default of 3 two pictures of the same size in a row left the first on
the TV for both slots while mpv (and its screenshot) had the second. Found when a portrait picture between two 1920x1080 photos was
removed (a size change makes mpv redraw several times, which hid it). Clearing the screen first (1.1.9) did not help.
(4) *The console under the player says what is happening* (`console.py`, agent 1.1.11): mpv draws over tty1, and when it exits the
TV falls back to that console, which held old boot or shutdown lines. The agent clears it and writes one centred message (in a
larger Terminus font when the Pi has one) when it starts ("Starting up"), before an agent update restarts it ("Updating the screen
software"), before a player restart or reboot, and before an OS update reboots. Best effort: a failure never stops the work.
(5) *Queue depth per item* (agent 1.1.12): the one-frame queue of (3) is set only while a picture is up; a video gets mpv's default
of 3 back (`set_property swapchain-depth` before each load), because with 1 mpv waits for every refresh and a Pi 3B+ played 1080p30
at about 10 fps. Status carries `playback` while a video plays (`fps` leaving the decoder, `fileFps`, dropped and late frames) so a
Pi that cannot keep up shows it. `hwdec v4l2m2m` (zero-copy) can be chosen per Pi but is untried on a Pi 3.

**Supported**: Raspberry Pi 3B+, 4 and 5 (bought on price), Raspberry Pi OS Lite 64-bit or the full desktop 64-bit image (switched to console boot by setup), **latest release only**
(`SUPPORTED_CODENAMES` in `services/signage-agent/signage_agent/apply.py`: Debian 13 "trixie" based, `VERSION_CODENAME` read from `/etc/os-release`). Setup refuses anything else with the reason;
a new Pi OS release is added to that list once it has been tried.

**Resolution**: v1 assumes every TV is 1080p. Images are made at 1920x1080 (portrait: 1080x1920) and videos to fit inside
1920x1080 at 30 fps, **portrait videos too** (1080x1920 becomes 608x1080), once, shared by every screen. The hardware H.264
decoder of a Pi 3 and 4 takes nothing taller than 1088 lines: a 1080x1920 phone video was never decoded (mpv kept the previous
video's last frame on the TV until the next picture, 2026-11-11). Videos stored before that rule are converted again from their
stored file by the `signage-media` job (`refitNext`, one per tick when no upload waits; the row stays `ready` and plays the old
file until the new one is stored). A portrait screen scales a portrait video up; a pre-rotated rendition for portrait screens
belongs to the per-screen renditions below.

**Later (lower priority): per-screen resolution.** `signage_screens.width/height` exist from the start and are reported in
`status` (the mode KMS chose), but are not used yet. The improvement: renditions per resolution (`signage_media_renditions`,
keyed by media + size; the manifest names the rendition for that screen), 4K images on a 4K TV, 720p for weak TVs, and a
warning when a screen's mode differs from what it is set to. Videos stay at most 1080p on Pi 3/4 (no 4K H.264 decode).

**Later (asked for 2026-11-11, not started): sound from videos.** Today every video is silent on purpose: the conversion strips the
soundtrack (`-an` in `renditionArgs`) and the player starts mpv with `--no-audio`. The agreed shape when it is built:
(1) the rendition keeps a stereo AAC track (originals are deleted after conversion, so videos uploaded before then must be uploaded
again to get their sound); (2) the player sends sound to the TV's HDMI output (ALSA, the vc4 HDMI device; it has no mixer, so the
level is mpv's `--volume` plus the TV's own), and setup adds the player account to the `audio` group; (3) a "Play sound" switch on
each playlist item, off by default, so silent screens stay silent, plus a per-screen volume and mute. A manifest item then carries
whether its sound plays; an older agent ignores the field and stays silent.

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

Pages: Screens, Screen detail, Media library, Playlists, Schedule (month calendar of one-time and repeating entries, a List view),
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
