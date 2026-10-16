import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { evaluatePosture, type PostureFacts, type PostureReport } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { apiTokens, backupSchedules, backups, ciscoSwitches, groupMemberships, groups, users } from "../db/schema";
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

    const [adminRows, userRows, boot, pending, tokenRows, ciscoRows, lastBackup, schedules] = await Promise.all([
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
      this.db.select({ c: sql<number>`count(*)` }).from(ciscoSwitches).where(isNull(ciscoSwitches.knownHostKey)),
      this.db
        // Epoch milliseconds: raw aggregates do not go through Drizzle's timestamp mapping (see CLAUDE.md, Database).
        .select({ at: sql<string | number | null>`extract(epoch FROM max(${backups.createdAt})) * 1000` })
        .from(backups)
        .where(eq(backups.status, "ready")),
      this.db.select({ c: sql<number>`count(*)` }).from(backupSchedules).where(eq(backupSchedules.enabled, true)),
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
      auditRetentionDays: typeof retention === "number" && retention >= 0 ? Math.floor(retention) : 365,
    };
  }
}
