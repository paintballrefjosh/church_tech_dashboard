import { describe, expect, it } from "vitest";
import {
  FORGET_FAILED_PREFIX,
  FORGET_WAIT_MS,
  buildApplyConfig,
  canonicalJson,
  deviceProblems,
  expandCidr,
  forgetVerdict,
  hostnameFor,
  identifyCodes,
  inBulkWindow,
  isPrivateUnicast,
  isRaspberryPiMac,
  isLikelyPi,
  judgeEvidence,
  nameMatchesPattern,
  needsAttention,
  parseBulkWindow,
  parseCidrList,
  readSignageSecurity,
  validateSettingValue,
  SIGNAGE_KEYS,
  type DeviceProblemInput,
} from "@lampstand/shared";

describe("signage discovery rules", () => {
  it("recognises Raspberry Pi MAC prefixes in any spelling", () => {
    expect(isRaspberryPiMac("b8:27:eb:12:34:56")).toBe(true);
    expect(isRaspberryPiMac("D83ADD123456")).toBe(true);
    expect(isRaspberryPiMac("2c-cf-67-00-00-01")).toBe(true);
    expect(isRaspberryPiMac("00:11:22:33:44:55")).toBe(false);
    expect(isRaspberryPiMac(null)).toBe(false);
  });

  it("lists only the strong evidence as likely Pis", () => {
    expect(["pi_mac", "name", "setup_banner"].every((e) => isLikelyPi(e as never))).toBe(true);
    expect(isLikelyPi("ssh_debian")).toBe(false);
    expect(isLikelyPi("ssh_other")).toBe(false);
  });

  it("ranks the evidence: MAC, then name, then a Debian banner", () => {
    expect(judgeEvidence({ mac: "DC:A6:32:00:00:01", name: null, banner: null, namePattern: "" }).evidence).toBe("pi_mac");
    expect(judgeEvidence({ mac: null, name: "raspberrypi", banner: null, namePattern: "" }).evidence).toBe("name");
    expect(judgeEvidence({ mac: null, name: "tv-lobby", banner: null, namePattern: "tv-*" }).evidence).toBe("name");
    expect(judgeEvidence({ mac: null, name: "printer", banner: "SSH-2.0-OpenSSH_10.0p2 Debian-7", namePattern: "tv-*" }).evidence).toBe("ssh_debian");
    expect(judgeEvidence({ mac: null, name: null, banner: "SSH-2.0-Cisco-1.25", namePattern: "" }).evidence).toBe("ssh_other");
    // A known network card that is not a Pi's (a VMware VM) is not "could be a Pi", whatever the banner says.
    expect(judgeEvidence({ mac: "00:50:56:9F:E1:7C", name: "plex", banner: "SSH-2.0-OpenSSH_9.2p1 Debian-2", namePattern: "tv-*" }).evidence).toBe("ssh_other");
    expect(judgeEvidence({ mac: "00:50:56:9F:E1:7C", name: "tv-lobby", banner: null, namePattern: "tv-*" }).evidence).toBe("name");
  });

  it("matches name patterns as whole names, case-insensitively, several at once", () => {
    expect(nameMatchesPattern("TV-Lobby", "tv-*")).toBe(true);
    expect(nameMatchesPattern("my-tv-lobby", "tv-*")).toBe(false);
    expect(nameMatchesPattern("pi3", "tv-*, pi?")).toBe(true);
    expect(nameMatchesPattern("a.b", "a?b")).toBe(true);
    expect(nameMatchesPattern("anything", "")).toBe(false);
  });

  it("expands a subnet to its host addresses, private only, at most a /22", () => {
    const r = expandCidr("10.20.30.0/30");
    expect(r).toEqual({ ips: ["10.20.30.1", "10.20.30.2"] });
    const s24 = expandCidr("192.168.1.77/24");
    expect("ips" in s24 && s24.ips.length).toBe(254);
    expect("ips" in s24 && s24.ips[0]).toBe("192.168.1.1");
    expect(expandCidr("10.0.0.0/21")).toHaveProperty("error");
    expect(expandCidr("8.8.8.0/24")).toHaveProperty("error");
    expect(expandCidr("10.0.0.5/32")).toEqual({ ips: ["10.0.0.5"] });
    expect(expandCidr("nonsense")).toHaveProperty("error");
  });

  it("accepts only private unicast addresses", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1", "100.64.0.1"]) expect(isPrivateUnicast(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "169.254.1.1", "8.8.8.8", "172.32.0.1", "224.0.0.1", "1.2.3"]) expect(isPrivateUnicast(ip)).toBe(false);
  });
});

describe("signage identify codes", () => {
  it("gives every device its own three-digit code", () => {
    const codes = identifyCodes(30);
    expect(new Set(codes).size).toBe(30);
    for (const c of codes) expect(c).toMatch(/^[1-9]\d\d$/);
    expect(() => identifyCodes(901)).toThrow();
    expect(identifyCodes(900)).toHaveLength(900);
  });
});

describe("signage security settings", () => {
  it("fills safe defaults and ignores nonsense", () => {
    const s = readSignageSecurity(() => undefined);
    expect(s).toMatchObject({ loginAccount: "dedicated", lockSetupPassword: false, refusePasswordLogin: false, refuseRootLogin: false, allowOnlyLogin: false, onlyDashboard: false, restrictKey: false, readOnlyRoot: true, firewall: false, setHostname: true });
    expect(readSignageSecurity((k) => (k === SIGNAGE_KEYS.loginAccount ? "root" : undefined)).loginAccount).toBe("dedicated");
  });

  it("builds the config the Pi receives; 'only the dashboard' off means any address", () => {
    const s = readSignageSecurity((k) => (k === SIGNAGE_KEYS.extraSources ? "10.0.5.0/24, 10.0.9.9" : undefined));
    const c = buildApplyConfig({ ...s, onlyDashboard: true }, { setupUser: "pi", dashboardSources: ["10.1.1.10/32"], timezone: "America/Chicago", deviceName: "Lobby TV #1", authorizedKeys: ["ssh-ed25519 AAAA"] });
    expect(c.onlyFrom).toEqual(["10.0.5.0/24", "10.0.9.9/32", "10.1.1.10/32"]);
    expect(c.hostname).toBe("lobby-tv-1");
    expect(buildApplyConfig({ ...s, onlyDashboard: false }, { setupUser: "pi", dashboardSources: ["10.1.1.10/32"], timezone: "UTC", deviceName: "x", authorizedKeys: [] }).onlyFrom).toEqual([]);
  });

  it("by default leaves the Pi's own SSH login rules alone, and only writes one when it is to be refused", () => {
    const ctx = { setupUser: "pi", dashboardSources: [], timezone: "UTC", deviceName: "x", authorizedKeys: [] };
    const d = buildApplyConfig(readSignageSecurity(() => undefined), ctx);
    expect([d.passwordLogin, d.rootLogin]).toEqual([null, null]);
    const strict = buildApplyConfig({ ...readSignageSecurity(() => undefined), refusePasswordLogin: true, refuseRootLogin: true }, ctx);
    expect([strict.passwordLogin, strict.rootLogin]).toEqual([false, false]);
  });

  it("writes canonical JSON with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: true, c: null }] })).toBe('{"a":[{"c":null,"d":true}],"b":1}');
  });

  it("validates the settings the way the API will", () => {
    expect(validateSettingValue(SIGNAGE_KEYS.loginAccount, "setup")).toBeNull();
    expect(validateSettingValue(SIGNAGE_KEYS.loginAccount, "root")).not.toBeNull();
    expect(validateSettingValue(SIGNAGE_KEYS.extraSources, "10.0.0.0/8, nope")).toContain("nope");
    expect(validateSettingValue(SIGNAGE_KEYS.osUpdateWindow, "Tue 02:00-04:00")).toBeNull();
    expect(validateSettingValue(SIGNAGE_KEYS.osUpdateWindow, "whenever")).not.toBeNull();
    expect(validateSettingValue(SIGNAGE_KEYS.setupUsername, "Pi User")).not.toBeNull();
    expect(validateSettingValue(SIGNAGE_KEYS.bulkWindow, "23:00-05:00")).toBeNull();
  });

  it("parses address lists and time windows", () => {
    expect(parseCidrList("10.0.0.1 10.0.0.0/24,bad")).toEqual({ cidrs: ["10.0.0.1/32", "10.0.0.0/24"], bad: ["bad"] });
    const w = parseBulkWindow("23:00-05:00")!;
    expect(inBulkWindow(w, 23 * 60 + 5)).toBe(true);
    expect(inBulkWindow(w, 4 * 60)).toBe(true);
    expect(inBulkWindow(w, 12 * 60)).toBe(false);
    expect(hostnameFor("!!!")).toBeNull();
  });
});

describe("signage needs attention", () => {
  const now = new Date("2026-11-08T16:00:00Z");
  const base: DeviceProblemInput = {
    status: "active",
    enabled: true,
    lastSeenAt: new Date(now.getTime() - 30_000),
    lastError: null,
    hostKeyMismatch: false,
    settingsApplied: true,
    keyOutOfDate: false,
    manifestApplied: 4,
    manifestWanted: 4,
    manifestWantedSince: null,
    shouldBeOn: true,
    hasScreen: true,
    latest: { clockSynced: true, playerRunning: true, diskFreeMb: 5000, diskTotalMb: 30000 },
    agentOutOfDate: false,
    currentAgent: "1.0.0",
  };

  it("is empty for a healthy device and for one switched off", () => {
    expect(deviceProblems(base, now)).toEqual([]);
    expect(deviceProblems({ ...base, enabled: false, lastSeenAt: null }, now)).toEqual([]);
  });

  it("reports offline as critical while the TV should be on, a warning otherwise, and nothing else then", () => {
    const off = deviceProblems({ ...base, lastSeenAt: new Date(now.getTime() - 10 * 60_000), settingsApplied: false }, now);
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ code: "offline", severity: "critical" });
    expect(deviceProblems({ ...base, lastSeenAt: null, shouldBeOn: false }, now)[0]).toMatchObject({ code: "offline", severity: "warning" });
  });

  it("lists drift, content behind, hardware and TV problems, most serious first", () => {
    const p = deviceProblems(
      {
        ...base,
        settingsApplied: false,
        manifestApplied: 3,
        manifestWantedSince: new Date(now.getTime() - 2 * 3_600_000),
        latest: { clockSynced: false, playerRunning: false, underVoltage: true, diskFreeMb: 1000, diskTotalMb: 30000, tvError: "no answer on 8060", missingMedia: 2, osUpdatesPending: 4 },
        agentOutOfDate: true,
      },
      now,
    );
    expect(p.map((x) => x.code)).toEqual(["player", "settings", "behind", "tv", "power", "disk", "clock", "os_updates", "agent"]);
    expect(p.find((x) => x.code === "behind")!.message).toContain("2 files");
    expect(needsAttention(p)).toBe(true);
    expect(needsAttention(deviceProblems({ ...base, hasScreen: false }, now))).toBe(false);
  });

  it("reports setup failures and a changed host key even when not active", () => {
    const p = deviceProblems({ ...base, status: "failed", lastError: "apt failed", hostKeyMismatch: true }, now);
    expect(p.map((x) => x.code)).toEqual(["setup_failed", "host_key"]);
  });
});

describe("signage forget waits for the reset", () => {
  const progress = (over: Partial<{ phase: string | null; bootId: string; readOnlyRoot: boolean }> = {}) => ({ phase: "running", startedBootId: "boot-1", bootId: "boot-1", readOnlyRoot: false, log: [], ...over });

  it("waits while the Pi has not restarted yet, or is not answering", () => {
    expect(forgetVerdict("boot-1", progress(), 60_000)).toEqual({ wait: true });
    expect(forgetVerdict("boot-1", null, 60_000)).toEqual({ wait: true });
  });

  it("waits while phase two runs after the restart that lifted the read-only root", () => {
    expect(forgetVerdict("boot-1", progress({ phase: "after-boot", bootId: "boot-2" }), 120_000)).toEqual({ wait: true });
  });

  it("stops at once when the Pi restarted and the note of the reset was lost (the tv1-pi case)", () => {
    const v = forgetVerdict("boot-1", progress({ phase: null, bootId: "boot-2", readOnlyRoot: true }), 120_000);
    expect(v.wait).toBe(false);
    expect(!v.wait && v.reason).toMatch(/did not carry on/);
  });

  it("stops at once when the read-only root is still on after the restart", () => {
    const v = forgetVerdict("boot-1", progress({ phase: "after-boot", bootId: "boot-2", readOnlyRoot: true }), 120_000);
    expect(!v.wait && v.reason).toMatch(/read-only root still on/);
  });

  it("gives up after the wait, whatever the Pi says, and an agent without a boot id only ever waits until then", () => {
    expect(forgetVerdict(null, progress({ phase: null, bootId: "boot-2" }), 60_000)).toEqual({ wait: true });
    const v = forgetVerdict("boot-1", progress(), FORGET_WAIT_MS);
    expect(!v.wait && v.reason).toMatch(/has not restarted after 15 minutes/);
  });

  it("names a failed reset as such, not as a failed setup", () => {
    const now = new Date("2026-11-08T16:00:00Z");
    const d = { status: "failed" as const, enabled: true, lastSeenAt: null, lastError: `${FORGET_FAILED_PREFIX}x`, hostKeyMismatch: false, settingsApplied: true, keyOutOfDate: false, manifestApplied: null, manifestWanted: null, manifestWantedSince: null, shouldBeOn: null, hasScreen: false, latest: null, agentOutOfDate: false, currentAgent: null };
    expect(deviceProblems(d, now)[0]!.message).toBe(`${FORGET_FAILED_PREFIX}x`);
    expect(deviceProblems({ ...d, status: "resetting", lastError: null }, now)[0]!.message).toMatch(/Being reset/);
  });
});
