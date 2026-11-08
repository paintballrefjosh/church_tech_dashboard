"""Pure renderers for the lock-down (no side effects, unit-tested): the sshd drop-in, authorized_keys, sudoers, nftables."""

import ipaddress
import re
from typing import Dict, List

KEY_RE = re.compile(r"^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{40,1000}( [A-Za-z0-9@._-]{1,80})?$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
CTL = "/usr/local/bin/signage-ctl"
BANNER = "lampstand-signage"


class ConfigError(ValueError):
    pass


def check_config(c: Dict) -> Dict:
    """Validate an apply config (SignageApplyConfig in packages/shared/src/signage/devices.ts)."""
    if not isinstance(c, dict) or c.get("v") != 1:
        raise ConfigError("unknown config version")
    if c.get("loginAccount") not in ("dedicated", "setup"):
        raise ConfigError("loginAccount")
    if not isinstance(c.get("setupUser"), str) or not USER_RE.match(c["setupUser"]):
        raise ConfigError("setupUser")
    for k in ("lockSetupPassword", "passwordLogin", "rootLogin", "allowOnlyLogin", "restrictKey", "firewall", "readOnlyRoot"):
        if not isinstance(c.get(k), bool):
            raise ConfigError(k)
    if not isinstance(c.get("onlyFrom"), list) or len(c["onlyFrom"]) > 64:
        raise ConfigError("onlyFrom")
    for cidr in c["onlyFrom"]:
        try:
            ipaddress.ip_network(cidr, strict=False)
        except (ValueError, TypeError):
            raise ConfigError(f"onlyFrom: {cidr!r}") from None
    keys = c.get("authorizedKeys")
    if not isinstance(keys, list) or not 1 <= len(keys) <= 4 or not all(isinstance(k, str) and KEY_RE.match(k) for k in keys):
        raise ConfigError("authorizedKeys")
    if c.get("hostname") is not None and not (isinstance(c["hostname"], str) and HOST_RE.match(c["hostname"])):
        raise ConfigError("hostname")
    for k in ("osUpdateWindow", "ntpServer", "timezone"):
        if not isinstance(c.get(k), str) or len(c[k]) > 200 or any(ch in c[k] for ch in "\n\r\0"):
            raise ConfigError(k)
    if c["ntpServer"] and not re.match(r"^[A-Za-z0-9.:-]{1,253}$", c["ntpServer"]):
        raise ConfigError("ntpServer")
    if not re.match(r"^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$", c["timezone"]):
        raise ConfigError("timezone")
    return c


def login_user(c: Dict) -> str:
    return "signage" if c["loginAccount"] == "dedicated" else c["setupUser"]


def sshd_dropin(c: Dict) -> str:
    """The drop-in. Debian's sshd_config includes sshd_config.d/*.conf FIRST and the first value of a keyword wins, so
    50-lampstand-signage.conf overrides the stock file."""
    lines = [
        "# Written by Lampstand (signage). Changed through Signage > Security settings, not by hand.",
        f"VersionAddendum {BANNER}",
        f"PasswordAuthentication {'yes' if c['passwordLogin'] else 'no'}",
        f"KbdInteractiveAuthentication {'yes' if c['passwordLogin'] else 'no'}",
        f"PermitRootLogin {'yes' if c['rootLogin'] else 'no'}",
        "PubkeyAuthentication yes",
        "X11Forwarding no",
        "AllowAgentForwarding no",
        "PermitTunnel no",
    ]
    if c["allowOnlyLogin"]:
        lines.append(f"AllowUsers {login_user(c)}")
    if c["onlyFrom"]:
        # Logins from elsewhere are refused outright (the key's from= covers the key; this covers passwords too).
        lines.append(f"Match Address *,!{',!'.join(c['onlyFrom'])}")
        lines.append("    DenyUsers *")
    return "\n".join(lines) + "\n"


def authorized_keys(c: Dict) -> str:
    opts: List[str] = []
    if c["onlyFrom"]:
        opts.append(f'from="{",".join(c["onlyFrom"])}"')
    if c["restrictKey"]:
        opts.append(f'command="{CTL}"')
        opts.append("restrict")
    prefix = (",".join(opts) + " ") if opts else ""
    return "".join(f"{prefix}{k}\n" for k in c["authorizedKeys"])


def sudoers(user: str) -> str:
    if not USER_RE.match(user):
        raise ConfigError("user")
    return f"# Written by Lampstand (signage).\n{user} ALL=(root) NOPASSWD: {CTL}\n"


def nft_rules(c: Dict) -> str:
    """Inbound: established traffic, loopback, ICMP, DHCP replies, mDNS/SSDP replies are local; SSH only from the
    dashboard list (or anywhere when the list is empty); everything else dropped. Outbound is untouched."""
    v4 = [x for x in c["onlyFrom"] if ":" not in x]
    ssh = f"ip saddr {{ {', '.join(v4)} }} tcp dport 22 accept" if v4 else "tcp dport 22 accept"
    return "\n".join(
        [
            "table inet lampstand_signage {",
            "  chain input {",
            "    type filter hook input priority 0; policy drop;",
            "    ct state established,related accept",
            "    iif lo accept",
            "    ip protocol icmp accept",
            "    ip6 nexthdr icmpv6 accept",
            "    udp dport 68 accept",
            f"    {ssh}",
            "  }",
            "}",
            "",
        ]
    )


def parse_sshd_t(text: str) -> Dict[str, str]:
    """`sshd -T` prints lower-case "keyword value" lines."""
    out: Dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0] not in out:
            out[parts[0]] = parts[1]
    return out


def sshd_drift(c: Dict, effective: Dict[str, str]) -> List[str]:
    """What `sshd -T` says that the config does not want (empty = as wanted)."""
    want = {
        "passwordauthentication": "yes" if c["passwordLogin"] else "no",
        "kbdinteractiveauthentication": "yes" if c["passwordLogin"] else "no",
        "permitrootlogin": "yes" if c["rootLogin"] else "no",
    }
    out = [f"{k} is {effective.get(k, '?')}, wanted {v}" for k, v in want.items() if effective.get(k) != v]
    if c["allowOnlyLogin"] and effective.get("allowusers", "").split() != [login_user(c)]:
        out.append(f"allowusers is {effective.get('allowusers', '(any)')!r}, wanted {login_user(c)}")
    return out
