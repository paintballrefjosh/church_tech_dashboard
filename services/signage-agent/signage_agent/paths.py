"""Where the agent keeps things. `SIGNAGE_ROOT` moves every path under a folder (tests only)."""

import os

ROOT = os.environ.get("SIGNAGE_ROOT", "")


def p(path: str) -> str:
    return ROOT + path if ROOT else path


DATA = p("/var/lib/signage")
MEDIA = p("/var/lib/signage/media")
PARTIAL = p("/var/lib/signage/media/.partial")
MANIFEST = p("/var/lib/signage/manifest.json")
APPLIED = p("/var/lib/signage/applied.json")
LOCAL_CONFIG = p("/var/lib/signage/config.json")
OS_UPDATE_STATE = p("/var/lib/signage/os-update.json")
ORIGINAL = p("/var/lib/signage/original.json")
RELEASE_STATE = p("/var/lib/signage/release.json")
RELEASE_LOG = p("/var/tmp/lampstand-signage-release.log")
CMDLINE = p("/boot/firmware/cmdline.txt")
RUN = p("/run/signage")
IDENTIFY = p("/run/signage/identify.json")
ADOPTING = p("/run/signage/adopting.json")
STATUS_CACHE = p("/run/signage/player.json")
CPU_SAMPLE = p("/run/signage/cpu.json")
HEALTHY = p("/run/signage/healthy")
OPT = p("/opt/signage")
AGENTS = p("/opt/signage/agent")
CURRENT = p("/opt/signage/agent/current")
PREVIOUS = p("/opt/signage/agent/previous")
CTL_LINK = p("/usr/local/bin/signage-ctl")
# 10-, not 50-: sshd takes the FIRST value of a keyword, and a fresh Pi's cloud-init writes 50-cloud-init.conf
# (PasswordAuthentication yes), which sorted before 50-lampstand-signage.conf and silently won.
SSHD_DROPIN = p("/etc/ssh/sshd_config.d/10-lampstand-signage.conf")
LEGACY_SSHD_DROPIN = p("/etc/ssh/sshd_config.d/50-lampstand-signage.conf")
SUDOERS = p("/etc/sudoers.d/lampstand-signage")
SYSTEMD = p("/etc/systemd/system")
NFT_FILE = p("/etc/lampstand-signage/firewall.nft")
ETC = p("/etc/lampstand-signage")
PENDING = p("/var/lib/signage/pending")
OVERLAY_LOWER = p("/media/root-ro")
SIMULATED = p("/etc/lampstand-signage-simulated")

PLAYER_USER = "signage-player"
DEDICATED_USER = "signage"
