import { describe, expect, it } from "vitest";
import { evaluatePosture, type PostureFacts } from "@church/shared";

const NOW = Date.UTC(2026, 9, 16);
const DAY = 86_400_000;

function facts(over: Partial<PostureFacts> = {}): PostureFacts {
  return {
    now: NOW,
    siteUrlSet: true,
    smtpConfigured: true,
    defaultAdminPassword: false,
    admins: { total: 2, withoutTotp: 0 },
    users: { total: 2, withoutTotp: 0 },
    requireTotpAdmin: true,
    requireTotpAll: false,
    signIn: { google: { enabled: false, workspaceDomain: "", allowExternal: false }, microsoft: { enabled: false, tenant: "common", allowedDomains: 0 } },
    pendingApprovals: 0,
    apiTokens: { enabled: true, active: 2, neverExpire: 0, operational: 0, idle: 0 },
    ciscoUnpinned: 0,
    maintenanceMode: false,
    backups: { lastReadyAt: NOW - DAY, scheduleEnabled: true },
    auditRetentionDays: 365,
    ...over,
  };
}
const byId = (r: ReturnType<typeof evaluatePosture>, id: string) => r.checks.find((c) => c.id === id);

describe("security posture", () => {
  it("a tidy site has nothing above ok", () => {
    const r = evaluatePosture(facts());
    expect(r.counts.critical + r.counts.warn + r.counts.info).toBe(0);
    expect(r.counts.ok).toBeGreaterThan(3);
  });

  it("the install password is critical and sorts first", () => {
    const r = evaluatePosture(facts({ defaultAdminPassword: true, siteUrlSet: false }));
    expect(r.checks[0]).toMatchObject({ id: "default-admin-password", severity: "critical" });
    expect(r.counts.critical).toBe(1);
  });

  it("administrators without two-factor warn, and say what the policy does", () => {
    const off = byId(evaluatePosture(facts({ requireTotpAdmin: false, admins: { total: 3, withoutTotp: 2 } })), "admin-two-factor")!;
    expect(off.severity).toBe("warn");
    expect(off.title).toBe("2 administrators without two-factor");
    expect(off.detail).toContain("Require two-factor");
    const on = byId(evaluatePosture(facts({ admins: { total: 3, withoutTotp: 1 } })), "admin-two-factor")!;
    expect(on.detail).toContain("can read but not change");
  });

  it("other accounts without two-factor are only a note, and nothing once it is required of everyone", () => {
    const base = { admins: { total: 1, withoutTotp: 0 }, users: { total: 6, withoutTotp: 5 } };
    expect(byId(evaluatePosture(facts(base)), "user-two-factor")).toMatchObject({ severity: "info", title: "5 other accounts without two-factor" });
    expect(byId(evaluatePosture(facts({ ...base, requireTotpAll: true })), "user-two-factor")?.severity).toBe("ok");
  });

  it("Microsoft on a shared tenant without domains is flagged, a single tenant or domains are fine", () => {
    const ms = (tenant: string, allowedDomains: number) => byId(evaluatePosture(facts({ signIn: { ...facts().signIn, microsoft: { enabled: true, tenant, allowedDomains } } })), "microsoft-sign-in")!;
    expect(ms("common", 0).severity).toBe("warn");
    expect(ms("organizations", 0).severity).toBe("warn");
    expect(ms("common", 2).severity).toBe("ok");
    expect(ms("8a1b2c3d-0000-1111-2222-333344445555", 0).severity).toBe("ok");
    expect(byId(evaluatePosture(facts()), "microsoft-sign-in")).toBeUndefined();
  });

  it("Google: open to any account warns, a domain is ok, external-with-approval is a note", () => {
    const g = (workspaceDomain: string, allowExternal: boolean) => byId(evaluatePosture(facts({ signIn: { ...facts().signIn, google: { enabled: true, workspaceDomain, allowExternal } } })), "google-sign-in")!;
    expect(g("", false).severity).toBe("warn");
    expect(g("church.org", false).severity).toBe("ok");
    expect(g("church.org", true).severity).toBe("info");
    expect(g("", true).severity).toBe("info");
  });

  it("tokens: never-expiring warns before idle, which only notes", () => {
    expect(byId(evaluatePosture(facts({ apiTokens: { enabled: true, active: 3, neverExpire: 1, operational: 0, idle: 2 } })), "api-tokens")).toMatchObject({ severity: "warn", title: "1 API token never expires" });
    expect(byId(evaluatePosture(facts({ apiTokens: { enabled: true, active: 3, neverExpire: 0, operational: 0, idle: 2 } })), "api-tokens")?.severity).toBe("info");
    expect(byId(evaluatePosture(facts({ apiTokens: { enabled: false, active: 0, neverExpire: 0, operational: 0, idle: 0 } })), "api-tokens")?.severity).toBe("ok");
    expect(byId(evaluatePosture(facts({ apiTokens: { enabled: true, active: 3, neverExpire: 0, operational: 2, idle: 0 } })), "api-tokens-operational")?.severity).toBe("info");
  });

  it("flags switches without a pinned key, paused alerts, and missing site address or mail", () => {
    const r = evaluatePosture(facts({ ciscoUnpinned: 2, maintenanceMode: true, siteUrlSet: false, smtpConfigured: false }));
    for (const id of ["cisco-host-keys", "maintenance-mode", "site-url", "smtp"]) expect(byId(r, id)?.severity).toBe("warn");
    expect(byId(r, "cisco-host-keys")!.title).toBe("2 switches without a pinned host key");
  });

  it("backups: none, stale, fresh", () => {
    expect(byId(evaluatePosture(facts({ backups: { lastReadyAt: null, scheduleEnabled: false } })), "backups")?.title).toBe("There is no backup yet");
    const stale = byId(evaluatePosture(facts({ backups: { lastReadyAt: NOW - 20 * DAY, scheduleEnabled: true } })), "backups")!;
    expect(stale).toMatchObject({ severity: "warn", title: "The last backup is 20 days ago" });
    expect(stale.detail).toContain("not producing");
    expect(byId(evaluatePosture(facts({ backups: { lastReadyAt: NOW - 3 * 3_600_000, scheduleEnabled: true } })), "backups")?.title).toBe("Last backup today");
  });

  it("audit retention: forever, short, long", () => {
    const sev = (d: number) => byId(evaluatePosture(facts({ auditRetentionDays: d })), "audit-retention")?.severity;
    expect(sev(0)).toBe("info");
    expect(sev(30)).toBe("warn");
    expect(sev(365)).toBe("ok");
  });

  it("orders by severity and keeps the counts honest", () => {
    const r = evaluatePosture(facts({ defaultAdminPassword: true, ciscoUnpinned: 1, pendingApprovals: 3 }));
    const sev = r.checks.map((c) => c.severity);
    const rank = { critical: 0, warn: 1, info: 2, ok: 3 } as const;
    expect([...sev].sort((a, b) => rank[a] - rank[b])).toEqual(sev);
    expect(r.counts.critical + r.counts.warn + r.counts.info + r.counts.ok).toBe(r.checks.length);
  });
});
