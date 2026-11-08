import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { SIGNAGE_KEYS, evaluatePosture, readSignageSecurity, type PostureFacts, type PostureReport } from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { apiTokens, backupSchedules, backups, ciscoSwitches, groupMemberships, groups, signageDevices, signageFound, users } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { readMaintenance } from "../monitors/maintenance";

const DAY_MS = 86_400_000;
/** The seeded administrator (`admin` / `admin`), stored as this address. */
const BOOTSTRAP_ADMIN_EMAIL = "admin@local";

const n = (v: unknown): number => Number(v ?? 0);

/** Gathers the counts and settings the Security overview judges (`evaluatePosture`). Nothing secret leaves here. */
@Injectable()
export class SecurityPostureService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async report(now: Date = new Date()): Promise<PostureReport> {
    return evaluatePosture(await this.facts(now));
  }

  async facts(now: Date = new Date()): Promise<PostureFacts> {
    const idleCut = new Date(now.getTime() - 90 * DAY_MS);
    const live = and(eq(users.isActive, true), isNull(users.deletedAt), eq(users.approvalStatus, "approved"));

    const [adminRows, userRows, boot, pending, tokenRows, ciscoRows, lastBackup, schedules, offsiteRows, checkRows, newestBackup] = await Promise.all([
      this.db
        .select({ total: sql<number>`count(*)`, withoutTotp: sql<number>`count(*) FILTER (WHERE ${users.totpEnabled} = false)` })
        .from(users)
        .innerJoin(groupMemberships, eq(groupMemberships.userId, users.id))
        .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
        .where(and(live, eq(groups.name, "admin"))),
      this.db
        .select({ total: sql<number>`count(*)`, withoutTotp: sql<number>`count(*) FILTER (WHERE ${users.totpEnabled} = false)` })
        .from(users)
        .where(live),
      this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, BOOTSTRAP_ADMIN_EMAIL), eq(users.isActive, true), isNull(users.deletedAt), eq(users.mustChangePassword, true)))
        .limit(1),
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.approvalStatus, "pending"), eq(users.isActive, true), isNull(users.deletedAt))),
      this.db
        .select({
          active: sql<number>`count(*)`,
          neverExpire: sql<number>`count(*) FILTER (WHERE ${apiTokens.expiresAt} IS NULL)`,
          operational: sql<number>`count(*) FILTER (WHERE ${apiTokens.allowOperational} = true)`,
          idle: sql<number>`count(*) FILTER (WHERE coalesce(${apiTokens.lastUsedAt}, ${apiTokens.createdAt}) < ${idleCut})`,
        })
        .from(apiTokens)
        .where(and(isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)))),
      this.db.select({ c: sql<number>`count(*)` }).from(ciscoSwitches).where(and(isNull(ciscoSwitches.knownHostKey), eq(ciscoSwitches.enabled, true))),
      this.db
        // Epoch milliseconds: raw aggregates do not go through Drizzle's timestamp mapping (see CLAUDE.md, Database).
        .select({ at: sql<string | number | null>`extract(epoch FROM max(${backups.createdAt})) * 1000` })
        .from(backups)
        .where(eq(backups.status, "ready")),
      this.db.select({ c: sql<number>`count(*)` }).from(backupSchedules).where(eq(backupSchedules.enabled, true)),
      this.db
        .select({
          at: sql<string | number | null>`extract(epoch FROM max(${backups.offsiteAt}) FILTER (WHERE ${backups.offsiteKey} IS NOT NULL)) * 1000`,
          // Only recent scheduled backups: an old failure nobody retries must not warn forever.
          failing: sql<number>`count(*) FILTER (WHERE ${backups.offsiteError} IS NOT NULL AND ${backups.kind} = 'scheduled' AND ${backups.createdAt} > ${new Date(now.getTime() - 14 * DAY_MS)})`,
        })
        .from(backups),
      this.db
        .select({
          at: sql<string | number | null>`extract(epoch FROM max(${backups.verifiedAt})) * 1000`,
          // Recent backups only: an old failure nobody retries must not warn forever.
          failing: sql<number>`count(*) FILTER (WHERE ${backups.verifyError} IS NOT NULL AND ${backups.createdAt} > ${new Date(now.getTime() - 14 * DAY_MS)})`,
        })
        .from(backups)
        .where(eq(backups.status, "ready")),
      this.db.select({ verifyError: backups.verifyError }).from(backups).where(eq(backups.status, "ready")).orderBy(desc(backups.createdAt)).limit(1),
    ]);

    const text = async (key: string): Promise<string> => {
      const v = await this.settings.get(key);
      return typeof v === "string" ? v.trim() : "";
    };
    const flag = async (key: string): Promise<boolean> => (await this.settings.get(key)) === true;
    const domains = (await text("microsoft.allowed_domains")).split(",").map((d) => d.trim()).filter(Boolean);
    const retention = await this.settings.get("audit.retention_days");
    const maintenance = await readMaintenance(this.settings, now.getTime());
    const lastReady = lastBackup[0]?.at != null ? Number(lastBackup[0].at) : null;

    return {
      now: now.getTime(),
      siteUrlSet: (await text("site.url")) !== "" || Boolean(process.env.APP_URL),
      smtpConfigured: (await text("smtp.host")) !== "",
      defaultAdminPassword: boot.length > 0,
      admins: { total: n(adminRows[0]?.total), withoutTotp: n(adminRows[0]?.withoutTotp) },
      users: { total: n(userRows[0]?.total), withoutTotp: n(userRows[0]?.withoutTotp) },
      requireTotpAdmin: await flag("auth.require_totp_admin"),
      requireTotpAll: await flag("auth.require_totp_all"),
      signIn: {
        google: {
          enabled: await flag("auth.google.enabled"),
          workspaceDomain: await text("google.workspace_domain"),
          allowExternal: await flag("google.allow_external_with_approval"),
        },
        microsoft: {
          enabled: await flag("auth.microsoft.enabled"),
          tenant: (await text("microsoft.oauth.tenant")) || "common",
          allowedDomains: domains.length,
        },
      },
      pendingApprovals: n(pending[0]?.c),
      apiTokens: {
        enabled: (await this.settings.get("auth.api_tokens_enabled")) !== false,
        active: n(tokenRows[0]?.active),
        neverExpire: n(tokenRows[0]?.neverExpire),
        operational: n(tokenRows[0]?.operational),
        idle: n(tokenRows[0]?.idle),
      },
      ciscoUnpinned: n(ciscoRows[0]?.c),
      maintenanceMode: maintenance.active,
      maintenanceUntil: maintenance.until,
      backups: { lastReadyAt: lastReady, scheduleEnabled: n(schedules[0]?.c) > 0 },
      backupChecks: {
        lastPassedAt: checkRows[0]?.at != null ? Number(checkRows[0].at) : null,
        newestFailing: newestBackup[0]?.verifyError != null,
        failing: n(checkRows[0]?.failing),
      },
      offsite: {
        enabled: await flag("backup.offsite.enabled"),
        lastCopyAt: offsiteRows[0]?.at != null ? Number(offsiteRows[0].at) : null,
        failing: n(offsiteRows[0]?.failing),
      },
      helpdeskEmail: {
        enabled: await flag("tickets.inbound.enabled"),
        auth: (await text("tickets.inbound.auth")) || "strict",
        authServerSet: (await text("tickets.inbound.auth_server")) !== "",
      },
      auditRetentionDays: typeof retention === "number" && retention >= 0 ? Math.floor(retention) : 365,
      publicStatus: await flag("monitoring.status_public"),
      signage: await this.signage(now),
    };
  }

  /** Only when Signage is in use: a set-up Pi, or a saved setup password. */
  private async signage(now: Date): Promise<PostureFacts["signage"]> {
    const [dev] = await this.db
      .select({ total: sql<number>`count(*) FILTER (WHERE ${signageDevices.status} = 'active')`, mismatch: sql<number>`count(*) FILTER (WHERE ${signageDevices.hostKeyMismatch} = true)` })
      .from(signageDevices);
    const saved = String((await this.settings.get(SIGNAGE_KEYS.setupPassword)) ?? "") !== "";
    const devices = n(dev?.total);
    if (!devices && !saved) return undefined;
    const [stale] = await this.db
      .select({ c: sql<number>`count(*)` })
      .from(signageFound)
      .where(
        and(
          isNull(signageFound.dismissedAt),
          sql`${signageFound.firstSeenAt} < ${new Date(now.getTime() - 7 * DAY_MS)}`,
          sql`NOT EXISTS (SELECT 1 FROM signage_devices d WHERE d.known_host_key = ${signageFound.hostKey})`,
        ),
      );
    const values = new Map<string, unknown>();
    for (const key of Object.values(SIGNAGE_KEYS)) values.set(key, await this.settings.get(key));
    const sec = readSignageSecurity((k) => values.get(k));
    return {
      devices,
      passwordLogin: sec.passwordLogin,
      rootLogin: sec.rootLogin,
      onlyDashboard: sec.onlyDashboard,
      restrictKey: sec.restrictKey,
      setupPasswordSaved: saved,
      staleFound: n(stale?.c),
      hostKeyMismatch: n(dev?.mismatch),
    };
  }
}
