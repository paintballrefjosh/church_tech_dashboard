import { isSingleTenant } from "./oauth-policy";
import { OFFSITE_STALE_DAYS } from "./backup-offsite";

/**
 * The admin "Security" overview: facts about how the site is set up, judged by plain rules into a list of checks an
 * administrator can read top to bottom. The API gathers `PostureFacts` (counts and settings, never secrets); everything
 * else is here so the rules are unit-tested (`apps/api/test/security-posture.test.ts`) and the page only draws them.
 */
export type PostureSeverity = "critical" | "warn" | "info" | "ok";

export interface PostureFacts {
  now: number; // epoch ms
  siteUrlSet: boolean;
  smtpConfigured: boolean;
  /** The built-in admin account still has the password it was installed with (its change is still forced). */
  defaultAdminPassword: boolean;
  admins: { total: number; withoutTotp: number };
  users: { total: number; withoutTotp: number };
  requireTotpAdmin: boolean;
  requireTotpAll: boolean;
  signIn: {
    google: { enabled: boolean; workspaceDomain: string; allowExternal: boolean };
    microsoft: { enabled: boolean; tenant: string; allowedDomains: number };
  };
  pendingApprovals: number;
  apiTokens: {
    enabled: boolean;
    active: number;
    neverExpire: number;
    operational: number;
    /** Active tokens not used for 90 days (or never used and older than that). */
    idle: number;
  };
  ciscoUnpinned: number;
  maintenanceMode: boolean;
  /** End of the maintenance window (epoch ms), or null when it has none. Only meaningful while `maintenanceMode`. */
  maintenanceUntil: number | null;
  backups: { lastReadyAt: number | null; scheduleEnabled: boolean };
  /** Copies in a second bucket: switched on, newest verified copy (epoch ms), backups whose last copy attempt failed. */
  offsite: { enabled: boolean; lastCopyAt: number | null; failing: number };
  auditRetentionDays: number;
}

export interface PostureCheck {
  id: string;
  title: string;
  severity: PostureSeverity;
  detail: string;
  /** Where to fix it, when there is a page for that. */
  fix?: { label: string; href: string };
}

export interface PostureReport {
  checks: PostureCheck[];
  counts: Record<PostureSeverity, number>;
}

const RANK: Record<PostureSeverity, number> = { critical: 0, warn: 1, info: 2, ok: 3 };
const DAY = 86_400_000;
const plural = (n: number, one: string, many: string = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ageText(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days < 1) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function evaluatePosture(f: PostureFacts): PostureReport {
  const checks: PostureCheck[] = [];
  const add = (c: PostureCheck) => checks.push(c);

  // ---- who can get in ----
  if (f.defaultAdminPassword) {
    add({
      id: "default-admin-password",
      title: "The built-in admin still has its starting password",
      severity: "critical",
      detail: "Anyone who knows the install default can sign in as administrator. Sign in as that account and choose a password.",
      fix: { label: "Open users", href: "/admin/users" },
    });
  } else {
    add({ id: "default-admin-password", title: "No account is using the install password", severity: "ok", detail: "The built-in admin has chosen its own password." });
  }

  const enforced = f.requireTotpAdmin || f.requireTotpAll;
  if (f.admins.total > 0 && f.admins.withoutTotp === 0) {
    add({ id: "admin-two-factor", title: "Every administrator uses two-factor", severity: "ok", detail: `${plural(f.admins.total, "administrator")}, all with an authenticator.` });
  } else if (f.admins.withoutTotp > 0) {
    add({
      id: "admin-two-factor",
      title: `${plural(f.admins.withoutTotp, "administrator")} without two-factor`,
      severity: "warn",
      detail: enforced
        ? "Two-factor is required, but these people have not set it up yet: they can read but not change anything until they do."
        : `Of ${f.admins.total} administrators. Turn on "Require two-factor for administrators" so a stolen password is not enough.`,
      fix: { label: "Sign-in settings", href: "/admin/settings/auth" },
    });
  }
  if (f.users.total > f.admins.total) {
    const others = f.users.withoutTotp - f.admins.withoutTotp;
    if (f.requireTotpAll) {
      add({ id: "user-two-factor", title: "Two-factor is required for everyone", severity: "ok", detail: "Anyone without it is asked to set it up before they can change anything." });
    } else if (others > 0) {
      add({
        id: "user-two-factor",
        title: `${plural(others, "other account")} without two-factor`,
        severity: "info",
        detail: "Two-factor is optional for non-administrators. Requiring it for everyone is a choice for the church to make.",
        fix: { label: "Sign-in settings", href: "/admin/settings/auth" },
      });
    }
  }
  if (f.admins.total > 5) {
    add({
      id: "admin-count",
      title: `${f.admins.total} people are administrators`,
      severity: "info",
      detail: "Administrators can change everything. Consider a lower tier for people who only run one area.",
      fix: { label: "Open groups", href: "/admin/groups" },
    });
  }

  // ---- outside sign-in ----
  if (f.signIn.microsoft.enabled && f.signIn.microsoft.allowedDomains === 0 && !isSingleTenant(f.signIn.microsoft.tenant)) {
    add({
      id: "microsoft-sign-in",
      title: "Microsoft sign-in is refusing everyone",
      severity: "warn",
      detail: "It is on, but the tenant is a shared endpoint and no allowed domains are set, so it would be open to any organisation and is turned away. Set the allowed domains, or a specific tenant id.",
      fix: { label: "Microsoft settings", href: "/admin/settings/microsoft" },
    });
  } else if (f.signIn.microsoft.enabled) {
    add({ id: "microsoft-sign-in", title: "Microsoft sign-in is limited to your organisation", severity: "ok", detail: "A specific tenant or a list of allowed domains is set." });
  }
  if (f.signIn.google.enabled) {
    const g = f.signIn.google;
    if (g.allowExternal) {
      add({
        id: "google-sign-in",
        title: "Anyone with a Google account may ask for access",
        severity: "info",
        detail: g.workspaceDomain
          ? `People outside ${g.workspaceDomain} wait for an administrator's approval before they can see anything.`
          : "Every new account waits for an administrator's approval before it can see anything.",
        fix: { label: "Google settings", href: "/admin/settings/google" },
      });
    } else if (!g.workspaceDomain) {
      add({
        id: "google-sign-in",
        title: "Any verified Google account can sign in",
        severity: "warn",
        detail: "No workspace domain is set and external accounts are not held for approval, so a stranger with a Gmail address is let in with the default access.",
        fix: { label: "Google settings", href: "/admin/settings/google" },
      });
    } else {
      add({ id: "google-sign-in", title: "Google sign-in is limited to your domain", severity: "ok", detail: `Only ${g.workspaceDomain} accounts are accepted.` });
    }
  }
  if (f.pendingApprovals > 0) {
    add({
      id: "pending-approvals",
      title: `${plural(f.pendingApprovals, "account")} waiting for approval`,
      severity: "info",
      detail: "People who signed in from outside your domain and cannot see anything until approved.",
      fix: { label: "Open users", href: "/admin/users" },
    });
  }

  // ---- API tokens ----
  if (!f.apiTokens.enabled) {
    add({ id: "api-tokens", title: "API tokens are switched off", severity: "ok", detail: "No script or agent can sign in with a token." });
  } else if (f.apiTokens.neverExpire > 0) {
    add({
      id: "api-tokens",
      title: `${plural(f.apiTokens.neverExpire, "API token")} never expire${f.apiTokens.neverExpire === 1 ? "s" : ""}`,
      severity: "warn",
      detail: "A token that never expires is a password that never changes. Replace it with one that does, or lower the maximum lifetime.",
      fix: { label: "API tokens", href: "/admin/api-tokens" },
    });
  } else if (f.apiTokens.idle > 0) {
    add({
      id: "api-tokens",
      title: `${plural(f.apiTokens.idle, "API token")} not used for 90 days`,
      severity: "info",
      detail: "Revoke tokens nobody uses any more.",
      fix: { label: "API tokens", href: "/admin/api-tokens" },
    });
  } else {
    add({ id: "api-tokens", title: "API tokens all expire and are in use", severity: "ok", detail: `${plural(f.apiTokens.active, "active token")}.` });
  }
  if (f.apiTokens.enabled && f.apiTokens.operational > 0) {
    add({
      id: "api-tokens-operational",
      title: `${plural(f.apiTokens.operational, "token")} can act on live equipment`,
      severity: "info",
      detail: "These tokens may change switches, DNS records and ProPresenter. Check each still needs to.",
      fix: { label: "API tokens", href: "/admin/api-tokens" },
    });
  }

  // ---- equipment ----
  if (f.ciscoUnpinned > 0) {
    add({
      id: "cisco-host-keys",
      title: `${plural(f.ciscoUnpinned, "switch", "switches")} without a pinned host key`,
      severity: "warn",
      detail: "The first poll records the key; until then a connection could be to an impostor. Check the switch is reachable.",
      fix: { label: "Open Cisco", href: "/monitoring/network-cisco" },
    });
  }

  // ---- running the site ----
  if (f.maintenanceMode && f.maintenanceUntil === null) {
    add({
      id: "maintenance-mode",
      title: "Alert notifications are paused with no end time",
      severity: "warn",
      detail: "Maintenance mode is on and nothing will turn it off: incidents are recorded but nobody is told. Switch it off when the work is done, or set it again with an end time.",
      fix: { label: "Open Monitoring", href: "/monitoring" },
    });
  } else if (f.maintenanceMode && f.maintenanceUntil !== null) {
    const mins = Math.max(1, Math.round((f.maintenanceUntil - f.now) / 60_000));
    const left = mins < 90 ? plural(mins, "minute") : mins < 36 * 60 ? plural(Math.round(mins / 60), "hour") : plural(Math.round(mins / 1440), "day");
    add({
      id: "maintenance-mode",
      title: `Alert notifications are paused for another ${left}`,
      severity: "info",
      detail: "Maintenance mode has an end time, so alerts resume by themselves. Incidents are recorded meanwhile.",
      fix: { label: "Open Monitoring", href: "/monitoring" },
    });
  }
  if (!f.siteUrlSet) {
    add({
      id: "site-url",
      title: "The site address is not set",
      severity: "warn",
      detail: "Password-reset and invitation emails carry a link that does not open until the Site URL is set.",
      fix: { label: "Site settings", href: "/admin/settings/site" },
    });
  }
  if (!f.smtpConfigured) {
    add({
      id: "smtp",
      title: "Outgoing email is not set up",
      severity: "warn",
      detail: "Password resets, alert emails and invitations cannot be delivered.",
      fix: { label: "SMTP settings", href: "/admin/settings/smtp" },
    });
  }
  if (f.backups.lastReadyAt === null) {
    add({
      id: "backups",
      title: "There is no backup yet",
      severity: "warn",
      detail: "Nothing can be restored if the database is lost.",
      fix: { label: "Backups", href: "/admin/backups" },
    });
  } else if (f.now - f.backups.lastReadyAt > 8 * DAY) {
    add({
      id: "backups",
      title: `The last backup is ${ageText(f.now - f.backups.lastReadyAt)}`,
      severity: "warn",
      detail: f.backups.scheduleEnabled ? "A schedule is on but is not producing backups. Check the Backups page." : "No schedule is turned on.",
      fix: { label: "Backups", href: "/admin/backups" },
    });
  } else {
    add({ id: "backups", title: `Last backup ${ageText(f.now - f.backups.lastReadyAt)}`, severity: "ok", detail: f.backups.scheduleEnabled ? "A schedule is on." : "Taken by hand; no schedule is turned on." });
  }
  if (f.backups.lastReadyAt !== null) {
    const offsiteFix = { label: "Offsite copies", href: "/admin/backups?tab=offsite" };
    if (!f.offsite.enabled) {
      add({
        id: "offsite",
        title: "Backups are only kept on this installation",
        severity: "info",
        detail: "A copy in another bucket survives losing this machine or its storage.",
        fix: offsiteFix,
      });
    } else if (f.offsite.lastCopyAt === null) {
      add({
        id: "offsite",
        title: "No backup has reached the offsite bucket yet",
        severity: f.offsite.failing > 0 ? "warn" : "info",
        detail: f.offsite.failing > 0 ? "The last attempt failed. See the Offsite tab for the reason." : "Copies are made after each scheduled backup.",
        fix: offsiteFix,
      });
    } else if (f.now - f.offsite.lastCopyAt > OFFSITE_STALE_DAYS * DAY) {
      add({
        id: "offsite",
        title: `The last offsite copy is ${ageText(f.now - f.offsite.lastCopyAt)}`,
        severity: "warn",
        detail: f.offsite.failing > 0 ? "Copies are failing. See the Offsite tab for the reason." : "Backups are being made but not copied. Check that the offsite schedule option is on.",
        fix: offsiteFix,
      });
    } else {
      add({ id: "offsite", title: `Last offsite copy ${ageText(f.now - f.offsite.lastCopyAt)}`, severity: f.offsite.failing > 0 ? "warn" : "ok", detail: f.offsite.failing > 0 ? "Some copies are failing. See the Offsite tab." : "Backups are also kept in another bucket." , fix: f.offsite.failing > 0 ? offsiteFix : undefined });
    }
  }
  if (f.auditRetentionDays === 0) {
    add({ id: "audit-retention", title: "The audit log is kept forever", severity: "info", detail: "It grows without limit. Set a retention window in the site settings.", fix: { label: "Site settings", href: "/admin/settings/site" } });
  } else if (f.auditRetentionDays < 90) {
    add({ id: "audit-retention", title: `The audit log keeps only ${f.auditRetentionDays} days`, severity: "warn", detail: "A problem found later than that cannot be traced.", fix: { label: "Site settings", href: "/admin/settings/site" } });
  } else {
    add({ id: "audit-retention", title: `The audit log keeps ${f.auditRetentionDays} days`, severity: "ok", detail: "Long enough to trace a problem found later." });
  }

  // Most urgent first; within a severity keep the order above (it reads as: people, sign-in, tokens, equipment, running).
  const ordered = checks.map((c, i) => ({ c, i })).sort((a, b) => RANK[a.c.severity] - RANK[b.c.severity] || a.i - b.i).map((x) => x.c);
  const counts: Record<PostureSeverity, number> = { critical: 0, warn: 0, info: 0, ok: 0 };
  for (const c of ordered) counts[c.severity]++;
  return { checks: ordered, counts };
}
