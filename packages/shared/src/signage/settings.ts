import { parseCidrList, type SignageLoginAccount, type SignageSecuritySettings } from "./devices";

/**
 * The Signage module's settings (category `signage`, managed by `signage:admin`). They are edited on the module's own
 * pages (/signage/settings), never under Admin > Settings (docs/signage.md section 6).
 */
export const SIGNAGE_KEYS = {
  setupUsername: "signage.setup_username",
  setupPassword: "signage.setup_password",
  keyGeneration: "signage.ssh_key_generation",
  loginAccount: "signage.login_account",
  lockSetupPassword: "signage.lock_setup_password",
  refusePasswordLogin: "signage.ssh_refuse_passwords",
  refuseRootLogin: "signage.ssh_refuse_root",
  allowOnlyLogin: "signage.ssh_allow_only_login",
  onlyDashboard: "signage.ssh_only_dashboard",
  extraSources: "signage.ssh_from",
  restrictKey: "signage.ssh_restrict_key",
  firewall: "signage.pi_firewall",
  readOnlyRoot: "signage.read_only_root",
  osUpdateWindow: "signage.os_update_window",
  ntpServer: "signage.ntp_server",
  setHostname: "signage.set_hostname",
  discoverNamePattern: "signage.discover_name_pattern",
  notifyNewPis: "signage.notify_new_pis",
  bulkWindow: "signage.bulk_window",
} as const;

/** Keys shown on the Security settings page (the rest are on the general Signage settings page or managed by actions). */
export const SIGNAGE_SECURITY_KEYS: readonly string[] = [
  SIGNAGE_KEYS.setupUsername,
  SIGNAGE_KEYS.setupPassword,
  SIGNAGE_KEYS.loginAccount,
  SIGNAGE_KEYS.lockSetupPassword,
  SIGNAGE_KEYS.refusePasswordLogin,
  SIGNAGE_KEYS.refuseRootLogin,
  SIGNAGE_KEYS.allowOnlyLogin,
  SIGNAGE_KEYS.onlyDashboard,
  SIGNAGE_KEYS.extraSources,
  SIGNAGE_KEYS.restrictKey,
  SIGNAGE_KEYS.firewall,
  SIGNAGE_KEYS.readOnlyRoot,
];

export const SIGNAGE_GENERAL_KEYS: readonly string[] = [
  SIGNAGE_KEYS.osUpdateWindow,
  SIGNAGE_KEYS.ntpServer,
  SIGNAGE_KEYS.setHostname,
  SIGNAGE_KEYS.discoverNamePattern,
  SIGNAGE_KEYS.notifyNewPis,
  SIGNAGE_KEYS.bulkWindow,
];

type Getter = (key: string) => unknown;

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);

/** The security settings with defaults filled in (the same as `KNOWN_SETTINGS`; changed 2026-11-11 to a relaxed set: lock-down is opt-in). */
export function readSignageSecurity(get: Getter): SignageSecuritySettings {
  const account = str(get(SIGNAGE_KEYS.loginAccount), "dedicated");
  return {
    loginAccount: (account === "setup" ? "setup" : "dedicated") as SignageLoginAccount,
    lockSetupPassword: bool(get(SIGNAGE_KEYS.lockSetupPassword), false),
    refusePasswordLogin: bool(get(SIGNAGE_KEYS.refusePasswordLogin), false),
    refuseRootLogin: bool(get(SIGNAGE_KEYS.refuseRootLogin), false),
    allowOnlyLogin: bool(get(SIGNAGE_KEYS.allowOnlyLogin), false),
    onlyDashboard: bool(get(SIGNAGE_KEYS.onlyDashboard), false),
    extraSources: parseCidrList(str(get(SIGNAGE_KEYS.extraSources), "")).cidrs,
    restrictKey: bool(get(SIGNAGE_KEYS.restrictKey), false),
    firewall: bool(get(SIGNAGE_KEYS.firewall), false),
    readOnlyRoot: bool(get(SIGNAGE_KEYS.readOnlyRoot), true),
    osUpdateWindow: str(get(SIGNAGE_KEYS.osUpdateWindow), "Tue 02:00-04:00") || "Tue 02:00-04:00",
    ntpServer: str(get(SIGNAGE_KEYS.ntpServer), ""),
    setHostname: bool(get(SIGNAGE_KEYS.setHostname), true),
  };
}

/** "HH:MM-HH:MM" (crossing midnight allowed). */
export function parseBulkWindow(text: string): { start: number; end: number } | null {
  const m = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/.exec(text);
  if (!m) return null;
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}

export function inBulkWindow(window: { start: number; end: number }, minuteOfDay: number): boolean {
  return window.start <= window.end ? minuteOfDay >= window.start && minuteOfDay < window.end : minuteOfDay >= window.start || minuteOfDay < window.end;
}
