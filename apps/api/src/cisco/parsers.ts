import { stripAnsi } from "./ssh";

/**
 * Cisco CLI parsers ported from the cisco-switch app (poller-ios.js /
 * poller-nxos.js / poller.js). Each takes raw shell output and returns
 * structured rows. OS is detected once per poll via `detectOS`.
 */

export type CiscoOs = "ios" | "nxos";

export function detectOS(raw: string): CiscoOs {
  return /NX-OS|Nexus Operating System|nxos/i.test(stripAnsi(raw)) ? "nxos" : "ios";
}

/** Canonical short interface name so config/status/mac all key identically. */
export function normalizeIfName(name: string): string {
  const m = /^([A-Za-z-]+)\s*([\d/.:]+)$/.exec(name.trim());
  if (!m) return name.trim();
  const base = m[1]!.toLowerCase().replace(/-/g, "");
  const num = m[2]!;
  const map: Array<[RegExp, string]> = [
    [/^te|^tengig/, "Te"],
    [/^twe|^twentyfive/, "Twe"],
    [/^fo|^fortygig/, "Fo"],
    [/^hu|^hundredgig/, "Hu"],
    [/^fi|^fivegig/, "Fi"],
    [/^gi|^gigabit/, "Gi"],
    [/^fa|^fastethernet/, "Fa"],
    [/^eth|^ethernet/, "Eth"],
    [/^po|^portchannel/, "Po"],
    [/^vl|^vlan/, "Vlan"],
    [/^lo|^loopback/, "Lo"],
    [/^mgmt|^management/, "Mgmt"],
    [/^tu|^tunnel/, "Tu"],
  ];
  for (const [re, short] of map) if (re.test(base)) return short + num;
  return name.trim();
}

const PHYSICAL_RE = /^(Gi|Te|Fa|Eth|Twe|Fo|Hu|Fi|Po)\d/;
export function isPhysicalPort(normName: string): boolean {
  return PHYSICAL_RE.test(normName);
}

/** `aaaa.bbbb.cccc` or `aa:bb:...` → normalised lowercase colon form. */
export function normaliseMac(raw: string): string {
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return raw.toLowerCase();
  return (hex.match(/.{2}/g) ?? []).join(":");
}

// ---- interfaces status → live oper state ----

export interface LivePort {
  portId: string;
  operStatus: string;
  mode: string | null;
  accessVlan: number | null;
}

export function parseInterfacesStatus(raw: string): LivePort[] {
  const out: LivePort[] = [];
  for (const rawLine of stripAnsi(raw).split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // Port  Name  Status  Vlan  Duplex  Speed  Type  (Name may be blank)
    const m = /^(\S+)\s+(.*?)\s+(connected|notconnect|notconnec|disabled|err-disabled|errdisabled|monitoring|suspended|inactive)\s+(\S+)\s+/i.exec(
      line,
    );
    if (!m) continue;
    const portId = normalizeIfName(m[1]!);
    if (!isPhysicalPort(portId)) continue;
    const status = m[3]!.toLowerCase();
    const vlanTok = m[4]!;
    let operStatus = "down";
    if (status.startsWith("connect")) operStatus = "up";
    else if (status.startsWith("err")) operStatus = "err-disabled";
    else if (status === "disabled") operStatus = "down";
    else operStatus = "notconnect";
    const mode = vlanTok === "trunk" ? "trunk" : vlanTok === "routed" ? "routed" : "access";
    const accessVlan = /^\d+$/.test(vlanTok) ? Number(vlanTok) : null;
    out.push({ portId, operStatus, mode, accessVlan });
  }
  return out;
}

// ---- running-config → desired-shaped ports + device facts ----

export interface CfgPort {
  portId: string;
  description: string;
  adminEnabled: boolean;
  speed: string;
  duplex: string;
  mode: string;
  hasSwitchport: boolean;
  accessVlan: number;
  trunkNativeVlan: number;
  trunkAllowedVlans: string;
}
export interface ParsedConfig {
  ports: CfgPort[];
  hostname: string | null;
  snmpLocation: string | null;
}

function blankPort(portId: string): CfgPort {
  return {
    portId,
    description: "",
    adminEnabled: true,
    speed: "auto",
    duplex: "auto",
    mode: "access",
    hasSwitchport: false,
    accessVlan: 1,
    trunkNativeVlan: 1,
    trunkAllowedVlans: "1-4094",
  };
}

export function parseRunningConfig(raw: string): ParsedConfig {
  const lines = stripAnsi(raw).split("\n").map((l) => l.replace(/\r$/, ""));
  const ports: CfgPort[] = [];
  let hostname: string | null = null;
  let snmpLocation: string | null = null;
  let cur: CfgPort | null = null;

  const flush = () => {
    if (!cur) return;
    // Apply mode-appropriate defaults.
    if (cur.mode === "access") {
      cur.speed = cur.speed === "" ? "auto" : cur.speed;
    }
    ports.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const ifm = /^interface\s+(\S+)/.exec(line);
    if (ifm) {
      flush();
      const norm = normalizeIfName(ifm[1]!);
      cur = isPhysicalPort(norm) ? blankPort(norm) : null;
      continue;
    }
    if (!cur) {
      const hn = /^hostname\s+(\S+)/.exec(line);
      if (hn) hostname = hn[1]!;
      const loc = /^snmp-server location\s+(.+)$/.exec(line);
      if (loc) snmpLocation = loc[1]!.trim();
      continue;
    }
    const body = line.trim();
    // Any `switchport ...` line means this is an L2 port (many platforms never
    // emit a bare `switchport`, only `switchport mode trunk` etc.).
    if (/^switchport\b/.test(body)) cur.hasSwitchport = true;
    if (/^shutdown\b/.test(body)) cur.adminEnabled = false;
    else if (/^no shutdown\b/.test(body)) cur.adminEnabled = true;
    let mm: RegExpExecArray | null;
    if ((mm = /^description\s+(.*)$/.exec(body))) cur.description = mm[1]!.trim();
    else if ((mm = /^speed\s+(\S+)/.exec(body))) {
      if (mm[1] !== "auto") cur.speed = mm[1]!;
    } else if ((mm = /^duplex\s+(\S+)/.exec(body))) cur.duplex = mm[1]!;
    else if ((mm = /^switchport access vlan\s+(\d+)/.exec(body))) cur.accessVlan = Number(mm[1]);
    else if ((mm = /^switchport trunk native vlan\s+(\d+)/.exec(body)))
      cur.trunkNativeVlan = Number(mm[1]);
    else if ((mm = /^switchport trunk allowed vlan add\s+(.+)$/.exec(body)))
      cur.trunkAllowedVlans = `${cur.trunkAllowedVlans},${mm[1]!.trim()}`;
    else if ((mm = /^switchport trunk allowed vlan\s+(.+)$/.exec(body)))
      cur.trunkAllowedVlans = mm[1]!.trim() === "all" ? "1-4094" : mm[1]!.trim();
    else if ((mm = /^switchport mode\s+(\S+)/.exec(body))) cur.mode = mm[1]!;
    else if (/^switchport$/.test(body)) cur.hasSwitchport = true;
  }
  flush();
  return { ports, hostname, snmpLocation };
}

/** Slice raw session output down to just the running-config for backups. */
export function extractRunningConfig(raw: string, os: CiscoOs): string {
  const text = stripAnsi(raw);
  const lines = text.split("\n");
  const startRe =
    os === "nxos" ? /^!Command:\s*show (running-config|run)/i : /^(Building configuration|Current configuration)/i;
  const endRe = /^(show inventory|NAME:|Chassis)/i;
  let start = lines.findIndex((l) => startRe.test(l.trim()));
  if (start < 0) start = lines.findIndex((l) => /^(version |hostname )/.test(l.trim()));
  if (start < 0) start = 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

export function parseModel(raw: string): string | null {
  const m = /PID:\s*(\S+)/.exec(stripAnsi(raw));
  return m ? m[1]! : null;
}

// ---- MAC table ----

export interface MacRow {
  vlan: number;
  macAddress: string;
  macType: string;
  portId: string;
}

export function parseMacTable(raw: string, os: CiscoOs): MacRow[] {
  const out: MacRow[] = [];
  const text = stripAnsi(raw);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    let m: RegExpExecArray | null;
    if (os === "nxos") {
      // *  <vlan> <mac> dynamic <age> <secure> <ntfy> <port>
      m = /^[*+]?\s*(\d+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+(dynamic|static)\s+\S+\s+\S+\s+\S+\s+(\S+)/i.exec(
        line,
      );
    } else {
      m = /^(\d+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+(DYNAMIC|STATIC)\s+(\S+)/i.exec(line);
    }
    if (!m) continue;
    out.push({
      vlan: Number(m[1]),
      macAddress: normaliseMac(m[2]!),
      macType: m[3]!.toLowerCase(),
      portId: normalizeIfName(m[4]!),
    });
  }
  return out;
}

// ---- ARP cache ----

export interface ArpRow {
  ipAddress: string;
  macAddress: string;
  interface: string;
  vrf: string;
}

export function parseArp(raw: string, os: CiscoOs): ArpRow[] {
  const out: ArpRow[] = [];
  const text = stripAnsi(raw);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    let m: RegExpExecArray | null;
    if (os === "nxos") {
      // <ip> <age> <mac(colon)> <intf> [vrf]
      m = /^(\d+\.\d+\.\d+\.\d+)\s+\S+\s+([0-9a-f:]{17})\s+(\S+)(?:\s+(\S+))?/i.exec(line);
      if (!m) continue;
      out.push({
        ipAddress: m[1]!,
        macAddress: m[2]!.toLowerCase(),
        interface: normalizeIfName(m[3]!),
        vrf: m[4] ?? "default",
      });
    } else {
      // Internet <ip> <age> <mac(dot)> ARPA <intf>
      m = /^Internet\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+\S+\s+(\S+)/i.exec(
        line,
      );
      if (!m) continue;
      out.push({
        ipAddress: m[1]!,
        macAddress: normaliseMac(m[2]!),
        interface: normalizeIfName(m[3]!),
        vrf: "default",
      });
    }
  }
  return out;
}

// ---- VLAN database ----

export interface VlanRow {
  vlanId: number;
  vlanName: string;
  vlanStatus: string;
}

export function parseVlans(raw: string): VlanRow[] {
  const out: VlanRow[] = [];
  for (const rawLine of stripAnsi(raw).split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const m = /^(\d+)\s+([\w-]+)\s+(active|act\/unsup|suspended|act\/lshut)/i.exec(line.trim());
    if (!m) continue;
    const id = Number(m[1]);
    if (id < 1 || id > 4094) continue;
    out.push({
      vlanId: id,
      vlanName: m[2]!,
      vlanStatus: /^act/i.test(m[3]!) ? "active" : "suspended",
    });
  }
  return out;
}

// ---- LLDP / CDP neighbors (detail) ----

export interface NeighborRow {
  localPort: string;
  neighborHostname: string;
  neighborIp: string | null;
  neighborPort: string | null;
  protocol: "lldp" | "cdp";
}

export function parseNeighbors(raw: string, protocol: "lldp" | "cdp"): NeighborRow[] {
  const text = stripAnsi(raw);
  const rows: NeighborRow[] = [];
  // Split into per-neighbor blocks on the divider lines both formats emit.
  const blocks = text.split(/-{5,}|={5,}|\bTotal entries displayed\b/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let local = "";
    let host = "";
    let port: string | null = null;
    let ip: string | null = null;
    if (protocol === "lldp") {
      local = (/Local Intf:\s*(\S+)/i.exec(block)?.[1] ?? /Local Port id:\s*(\S+)/i.exec(block)?.[1]) ?? "";
      host = /System Name:\s*(.+)/i.exec(block)?.[1]?.trim() ?? "";
      port = /Port id:\s*(.+)/i.exec(block)?.[1]?.trim() ?? null;
      ip = /(?:Management Addresses?|IP:)[\s\S]*?(\d+\.\d+\.\d+\.\d+)/i.exec(block)?.[1] ?? null;
    } else {
      host = /Device ID:\s*(.+)/i.exec(block)?.[1]?.trim() ?? "";
      local = /Interface:\s*([^,\n]+)/i.exec(block)?.[1]?.trim() ?? "";
      port = /Port ID \(outgoing port\):\s*(.+)/i.exec(block)?.[1]?.trim() ?? null;
      ip = /IP(?:v4)? address:\s*(\d+\.\d+\.\d+\.\d+)/i.exec(block)?.[1] ?? null;
    }
    if (!local || !host) continue;
    rows.push({
      localPort: normalizeIfName(local),
      neighborHostname: host.replace(/\.[\w.]+$/, "").trim() || host.trim(),
      neighborIp: ip,
      neighborPort: port,
      protocol,
    });
  }
  return rows;
}
