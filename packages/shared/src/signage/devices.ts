import { SIGNAGE_LIMITS, type SignageDeviceProblem, type SignageDeviceStatus, type SignageEvidence, type SignagePiStatus } from "./schemas";

/**
 * Pure rules about Pis (docs/signage.md sections 2, 5, 6): recognising one during discovery, what "needs attention" means,
 * identify codes, and the security settings as the Pi receives them.
 */

// ---------------------------------------------------------------- discovery

/** Raspberry Pi Ltd / Raspberry Pi Trading MAC prefixes (IEEE registry). */
export const RASPBERRY_PI_OUIS = ["B8:27:EB", "DC:A6:32", "E4:5F:01", "28:CD:C1", "D8:3A:DD", "2C:CF:67", "88:A2:9E"] as const;

export function normaliseMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/../g)!.join(":");
}

export function isRaspberryPiMac(mac: string | null | undefined): boolean {
  const m = normaliseMac(mac);
  return !!m && RASPBERRY_PI_OUIS.some((o) => m.startsWith(o));
}

/** A shell-style pattern (`*`, `?`), case-insensitive, matched against the whole name. Blank matches nothing. */
export function nameMatchesPattern(name: string | null | undefined, pattern: string): boolean {
  const pats = pattern.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!name || pats.length === 0) return false;
  return pats.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(name));
}

/** The banner comment a stock Pi shows while it waits for setup is plain Debian; ours adds this after setup has started. */
export const SIGNAGE_SETUP_BANNER = "church-signage";

/** How sure we are an SSH host is a Pi for signage, best first, with the reason in words. */
export function judgeEvidence(input: { mac: string | null; name: string | null; banner: string | null; namePattern: string }): { evidence: SignageEvidence; text: string } {
  if (isRaspberryPiMac(input.mac)) return { evidence: "pi_mac", text: `Raspberry Pi (by MAC ${normaliseMac(input.mac)})` };
  if (input.name && nameMatchesPattern(input.name, input.namePattern || "raspberrypi*")) return { evidence: "name", text: `Name matches (${input.name})` };
  if (input.banner && input.banner.includes(SIGNAGE_SETUP_BANNER)) return { evidence: "setup_banner", text: "Set up by this dashboard before" };
  if (input.banner && /debian|raspbian/i.test(input.banner)) return { evidence: "ssh_debian", text: "SSH, Debian (could be a Pi)" };
  return { evidence: "ssh_other", text: input.banner ? `SSH (${input.banner.slice(0, 60)})` : "SSH" };
}

export function evidenceRank(e: SignageEvidence): number {
  return ["pi_mac", "name", "setup_banner", "ssh_debian", "ssh_other"].indexOf(e);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Private unicast IPv4 (RFC 1918, or CGNAT 100.64/10), never loopback, link-local, multicast or broadcast. */
export function isPrivateUnicast(ip: string): boolean {
  const n = ipToInt(ip);
  if (n === null) return false;
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * The host addresses in a CIDR (network and broadcast left out for /30 and wider), or an error in words. At most
 * `SIGNAGE_LIMITS.maxScanAddresses`, and only private address space.
 */
export function expandCidr(cidr: string): { ips: string[] } | { error: string } {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return { error: "Use a subnet like 10.20.30.0/24" };
  const base = ipToInt(m[1]!);
  const bits = Number(m[2]);
  if (base === null || bits < 0 || bits > 32) return { error: "That is not a subnet" };
  const size = 2 ** (32 - bits);
  if (size > SIGNAGE_LIMITS.maxScanAddresses) return { error: `Scan at most ${SIGNAGE_LIMITS.maxScanAddresses} addresses at once (a /22)` };
  const net = bits === 0 ? 0 : (base & (~0 << (32 - bits))) >>> 0;
  const ips: string[] = [];
  for (let i = 0; i < size; i++) {
    if (size >= 4 && (i === 0 || i === size - 1)) continue;
    ips.push(intToIp((net + i) >>> 0));
  }
  if (!ips.every(isPrivateUnicast)) return { error: "Only private addresses (10.x, 172.16-31.x, 192.168.x) can be scanned" };
  return { ips };
}

// ---------------------------------------------------------------- identify

/** `count` distinct three-digit codes ("100" to "999"). `random` returns [0, 1). */
export function identifyCodes(count: number, random: () => number = Math.random): string[] {
  if (count > 900) throw new Error("At most 900 devices can be identified at once");
  const pool = Array.from({ length: 900 }, (_, i) => String(100 + i));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

// ---------------------------------------------------------------- security settings

export type SignageLoginAccount = "dedicated" | "setup";

/** What `signage-ctl apply` receives (and what the dashboard compares with what the Pi reports). */
export interface SignageApplyConfig {
  v: 1;
  loginAccount: SignageLoginAccount;
  /** The Imager account; its password is locked when `lockSetupPassword`. */
  setupUser: string;
  lockSetupPassword: boolean;
  passwordLogin: boolean;
  rootLogin: boolean;
  allowOnlyLogin: boolean;
  /** CIDRs allowed to connect; empty = any address. */
  onlyFrom: string[];
  restrictKey: boolean;
  firewall: boolean;
  readOnlyRoot: boolean;
  /** Monitor-schedule syntax, e.g. "Tue 02:00-04:00". */
  osUpdateWindow: string;
  ntpServer: string;
  timezone: string;
  hostname: string | null;
  /** The dashboard's public keys (current generation first). */
  authorizedKeys: string[];
}

export interface SignageSecuritySettings {
  loginAccount: SignageLoginAccount;
  lockSetupPassword: boolean;
  passwordLogin: boolean;
  rootLogin: boolean;
  allowOnlyLogin: boolean;
  onlyDashboard: boolean;
  extraSources: string[];
  restrictKey: boolean;
  firewall: boolean;
  readOnlyRoot: boolean;
  osUpdateWindow: string;
  ntpServer: string;
  setHostname: boolean;
}

/** Turn a device name into a hostname label: lower case, a-z 0-9 and hyphens, at most 63. */
export function hostnameFor(name: string): string | null {
  const h = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
  return h || null;
}

export function parseCidrList(text: string): { cidrs: string[]; bad: string[] } {
  const cidrs: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const withMask = raw.includes("/") ? raw : `${raw}/32`;
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(withMask);
    if (!m || ipToInt(m[1]!) === null || Number(m[2]) > 32) bad.push(raw);
    else cidrs.push(withMask);
  }
  return { cidrs: [...new Set(cidrs)], bad };
}

export function buildApplyConfig(s: SignageSecuritySettings, ctx: { setupUser: string; dashboardSources: string[]; timezone: string; deviceName: string; authorizedKeys: string[] }): SignageApplyConfig {
  return {
    v: 1,
    loginAccount: s.loginAccount,
    setupUser: ctx.setupUser,
    lockSetupPassword: s.lockSetupPassword,
    passwordLogin: s.passwordLogin,
    rootLogin: s.rootLogin,
    allowOnlyLogin: s.allowOnlyLogin,
    onlyFrom: s.onlyDashboard ? [...new Set([...ctx.dashboardSources, ...s.extraSources])].sort() : [],
    restrictKey: s.restrictKey,
    firewall: s.firewall,
    readOnlyRoot: s.readOnlyRoot,
    osUpdateWindow: s.osUpdateWindow,
    ntpServer: s.ntpServer,
    timezone: ctx.timezone,
    hostname: s.setHostname ? hostnameFor(ctx.deviceName) : null,
    authorizedKeys: ctx.authorizedKeys,
  };
}

/** Stable text of a config (sorted keys), so a hash of it is the same on the dashboard and the Pi. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Which login the dashboard uses on a set-up Pi. */
export function loginUserFor(config: Pick<SignageApplyConfig, "loginAccount" | "setupUser">): string {
  return config.loginAccount === "dedicated" ? "signage" : config.setupUser;
}

// ---------------------------------------------------------------- needs attention

export interface DeviceProblemInput {
  status: SignageDeviceStatus;
  enabled: boolean;
  lastSeenAt: Date | null;
  lastError: string | null;
  hostKeyMismatch: boolean;
  settingsApplied: boolean;
  keyOutOfDate: boolean;
  manifestApplied: number | null;
  manifestWanted: number | null;
  manifestWantedSince: Date | null;
  /** Whether the screen's TV should be on now (null = power not managed or no screen). */
  shouldBeOn: boolean | null;
  hasScreen: boolean;
  latest: SignagePiStatus | null;
  agentOutOfDate: boolean;
  currentAgent: string | null;
}

/** Everything about one device that needs a person, most serious first (`[]` = all fine). */
export function deviceProblems(d: DeviceProblemInput, now: Date): SignageDeviceProblem[] {
  if (!d.enabled || d.status === "disabled") return [];
  const out: SignageDeviceProblem[] = [];
  if (d.status === "failed") out.push({ code: "setup_failed", severity: "critical", message: d.lastError ? `Setup failed: ${d.lastError}` : "Setup did not finish" });
  if (d.status === "setting_up") out.push({ code: "setting_up", severity: "info", message: "Being set up" });
  if (d.hostKeyMismatch) out.push({ code: "host_key", severity: "critical", message: "Its SSH host key changed: logins are refused until you trust the new key (or re-flash and set it up again)" });
  if (d.status !== "active") return out;
  const silentMin = d.lastSeenAt ? (now.getTime() - d.lastSeenAt.getTime()) / 60_000 : Infinity;
  if (silentMin >= SIGNAGE_LIMITS.offlineAfterMin) {
    const since = d.lastSeenAt ? `last answered ${Math.round(silentMin)} min ago` : "has never answered";
    out.push({ code: "offline", severity: d.shouldBeOn === false ? "warning" : "critical", message: `Offline: ${since}${d.lastError ? ` (${d.lastError})` : ""}` });
    return out;
  }
  if (!d.settingsApplied) out.push({ code: "settings", severity: "warning", message: "Its security or system settings differ from the Signage settings: apply them again" });
  if (d.keyOutOfDate) out.push({ code: "key", severity: "warning", message: "It still has the old dashboard key" });
  if (!d.hasScreen) out.push({ code: "no_screen", severity: "info", message: "Not assigned to a screen" });
  if (d.manifestWanted !== null && d.manifestApplied !== d.manifestWanted && d.manifestWantedSince && now.getTime() - d.manifestWantedSince.getTime() > SIGNAGE_LIMITS.syncBehindMin * 60_000) {
    const missing = d.latest?.missingMedia ? ` (${d.latest.missingMedia} file${d.latest.missingMedia === 1 ? "" : "s"} still to copy)` : "";
    out.push({ code: "behind", severity: "warning", message: `Content is more than an hour behind${missing}` });
  }
  const s = d.latest;
  if (s) {
    if (s.playerRunning === false) out.push({ code: "player", severity: "critical", message: "The player is not running" });
    if (s.tvError) out.push({ code: "tv", severity: "warning", message: `The TV is not responding: ${s.tvError}` });
    if (s.underVoltage) out.push({ code: "power", severity: "warning", message: "Under-voltage: use the official power supply, not the TV's USB port" });
    if (s.diskFreeMb !== null && s.diskFreeMb !== undefined && s.diskTotalMb && s.diskFreeMb / s.diskTotalMb < 0.15) out.push({ code: "disk", severity: "warning", message: `Disk ${Math.round((1 - s.diskFreeMb / s.diskTotalMb) * 100)}% full` });
    if (s.clockSynced === false) out.push({ code: "clock", severity: "warning", message: "Its clock is not synced: it plays the fallback and skips power times until it is" });
    if (s.cpuTempC !== null && s.cpuTempC !== undefined && s.cpuTempC >= 80) out.push({ code: "temperature", severity: "warning", message: `Running hot (${Math.round(s.cpuTempC)} C)` });
    if ((s.osUpdatesPending ?? 0) > 0) out.push({ code: "os_updates", severity: "info", message: `${s.osUpdatesPending} OS update${s.osUpdatesPending === 1 ? "" : "s"} waiting for the update window` });
  }
  if (d.agentOutOfDate) out.push({ code: "agent", severity: "info", message: `Agent ${s?.agentVersion ?? "unknown"} (current is ${d.currentAgent})` });
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Problems that put a device on the "Needs attention" tab (info-only ones do not). */
export function needsAttention(problems: SignageDeviceProblem[]): boolean {
  return problems.some((p) => p.severity !== "info");
}
