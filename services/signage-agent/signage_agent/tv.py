"""TV control: Roku ECP (HTTP on port 8060, the Roku on the Pi's own network) and HDMI-CEC (`cec-ctl`).

The wanted state comes from the manifest's `tv` block; the agent retries until the TV reports it."""

import ipaddress
import re
import socket
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from typing import Dict, Optional

from .util import have, run

INPUTS = {"InputHDMI1", "InputHDMI2", "InputHDMI3", "InputHDMI4", "InputAV1", "InputTuner"}
CEC_INPUTS = {"InputHDMI1": "1.0.0.0", "InputHDMI2": "2.0.0.0", "InputHDMI3": "3.0.0.0", "InputHDMI4": "4.0.0.0"}


class TvError(Exception):
    pass


def _private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return a.version == 4 and a.is_private and not a.is_loopback and not a.is_link_local
    except ValueError:
        return False


class Roku:
    def __init__(self, ip: str, timeout: float = 5.0) -> None:
        if not _private(ip):
            raise TvError(f"{ip} is not a private address")
        self.base = f"http://{ip}:8060"
        self.timeout = timeout

    def _req(self, method: str, path: str) -> bytes:
        req = urllib.request.Request(self.base + path, method=method, data=b"" if method == "POST" else None)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:  # noqa: S310 (private address, fixed port)
                return r.read(256 * 1024)
        except (urllib.error.URLError, OSError) as e:
            raise TvError(f"the Roku at {self.base} did not answer: {e}") from None

    def info(self) -> Dict[str, Optional[str]]:
        root = ET.fromstring(self._req("GET", "/query/device-info"))
        def t(name: str) -> Optional[str]:
            el = root.find(name)
            return el.text if el is not None else None
        mode = (t("power-mode") or "").lower()
        return {"power": "on" if mode == "poweron" else ("standby" if mode else "unknown"), "serial": t("serial-number"), "model": t("model-name"), "input": None}

    def power(self, state: str) -> None:
        self._req("POST", "/keypress/PowerOn" if state == "on" else "/keypress/PowerOff")

    def input(self, name: str) -> None:
        if name not in INPUTS:
            raise TvError("unknown input")
        self._req("POST", f"/keypress/{name}")


class Cec:
    """HDMI-CEC through the kernel's CEC device (vc4 on the Pi). The Pi registers as a playback device."""

    def __init__(self, device: str = "/dev/cec0") -> None:
        if not have("cec-ctl"):
            raise TvError("cec-ctl is not installed")
        self.dev = device

    def _ctl(self, *args: str) -> str:
        code, out, err = run(["cec-ctl", "-d", self.dev, *args], timeout=15)
        if code != 0:
            raise TvError((err or out).strip()[-300:] or f"cec-ctl failed ({code})")
        return out

    def setup(self) -> None:
        self._ctl("--playback", "-o", "Signage")

    def info(self) -> Dict[str, Optional[str]]:
        self.setup()
        out = self._ctl("--to", "0", "--give-device-power-status")
        m = re.search(r"pwr-state:\s*(\S+)", out)
        state = (m.group(1) if m else "").lower()
        power = "on" if state == "on" else ("standby" if state in ("standby", "to-standby") else "unknown")
        return {"power": power, "serial": None, "model": None, "input": None}

    def power(self, state: str) -> None:
        self.setup()
        if state == "on":
            self._ctl("--to", "0", "--image-view-on")
        else:
            self._ctl("--to", "0", "--standby")

    def input(self, name: str) -> None:
        addr = CEC_INPUTS.get(name)
        if not addr:
            raise TvError(f"{name} cannot be chosen over CEC")
        self.setup()
        self._ctl("--to", "15", "--active-source", f"phys-addr={addr}")


def driver(tv: Dict):
    """The driver for a manifest's `tv` block, or None when the TV is not controlled."""
    control = (tv or {}).get("control")
    if control == "roku_ecp" and tv.get("rokuIp"):
        return Roku(tv["rokuIp"])
    if control in ("cec", "roku_ecp"):
        return Cec()
    return None


def ssdp_find_roku(timeout: float = 3.0) -> Optional[str]:
    """Ask the Pi's own network segment for a Roku (SSDP). Returns its address, or None."""
    msg = b"M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nMan: \"ssdp:discover\"\r\nST: roku:ecp\r\n\r\n"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.settimeout(timeout)
    try:
        s.sendto(msg, ("239.255.255.250", 1900))
        while True:
            data, _ = s.recvfrom(2048)
            m = re.search(rb"(?im)^location:\s*http://([0-9.]+):8060", data)
            if m and _private(m.group(1).decode()):
                return m.group(1).decode()
    except OSError:
        return None
    finally:
        s.close()
