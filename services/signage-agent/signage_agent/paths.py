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
RUN = p("/run/signage")
IDENTIFY = p("/run/signage/identify.json")
STATUS_CACHE = p("/run/signage/player.json")
HEALTHY = p("/run/signage/healthy")
OPT = p("/opt/signage")
AGENTS = p("/opt/signage/agent")
CURRENT = p("/opt/signage/agent/current")
PREVIOUS = p("/opt/signage/agent/previous")
CTL_LINK = p("/usr/local/bin/signage-ctl")
SSHD_DROPIN = p("/etc/ssh/sshd_config.d/50-church-signage.conf")
SUDOERS = p("/etc/sudoers.d/church-signage")
SYSTEMD = p("/etc/systemd/system")
NFT_FILE = p("/etc/church-signage/firewall.nft")
ETC = p("/etc/church-signage")
PENDING = p("/var/lib/signage/pending")
OVERLAY_LOWER = p("/media/root-ro")
SIMULATED = p("/etc/church-signage-simulated")

PLAYER_USER = "signage-player"
DEDICATED_USER = "signage"
