import { Controller, Get, Put, Post, Patch, Body, BadRequestException, ConflictException, Inject } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { NOTIFICATION_KINDS, TICKET_PRIORITIES, type TicketSlaMap } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "./current-user.decorator";
import { AuthService } from "./auth.service";
import { SettingsService } from "../settings/settings.service";
import { DB, type Db } from "../db/db.module";
import { users, credentials, notificationPrefs } from "../db/schema";
import { Audited } from "../audit/audit.decorator";
import { SessionOnly } from "./session-only.decorator";

const changePasswordBody = z.object({
  newPassword: z.string().min(8).max(256),
});

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// Self-service profile updates. Email + display name only — role/group changes
// stay admin-only. pageWidth/pageWidthPx are per-user UI preferences
// (see migrations 0009 + 0010 and apps/web/src/app/me/display-form.tsx).
//
// pageWidthPx is only meaningful when pageWidth === "custom"; the controller
// blanks it out otherwise so the DB never holds a value the UI would ignore.
const PAGE_WIDTH_VALUES = ["fluid", "narrow", "standard", "wide", "custom"] as const;
const updateProfileBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  pageWidth: z.enum(PAGE_WIDTH_VALUES).optional(),
  pageWidthPx: z.number().int().min(640).max(2560).nullable().optional(),
});

@Controller("me")
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    // Re-read mustChangePassword + page width prefs + muted notification kinds
    // from DB so the UI sees fresh state after a change.
    const [row] = await this.db
      .select({
        mustChangePassword: users.mustChangePassword,
        approvalStatus: users.approvalStatus,
        pageWidth: users.pageWidth,
        pageWidthPx: users.pageWidthPx,
        mutedNotificationKinds: users.mutedNotificationKinds,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    // SLA targets ship with /me because they're tiny, rarely change, and the
    // UI needs them to render overdue badges on every ticket card.
    const slaPairs = await Promise.all(
      TICKET_PRIORITIES.map(async (p) => [
        p,
        {
          responseMin: numberOr(await this.settings.get(`tickets.sla.response_min.${p}`), 0),
          resolutionMin: numberOr(await this.settings.get(`tickets.sla.resolution_min.${p}`), 0),
        },
      ] as const),
    );
    const slaTargets = Object.fromEntries(slaPairs) as TicketSlaMap;

    return {
      ...user,
      mustChangePassword: row?.mustChangePassword ?? false,
      approvalStatus: row?.approvalStatus === "pending" ? "pending" : "approved",
      pageWidth: row?.pageWidth ?? "standard",
      pageWidthPx: row?.pageWidthPx ?? null,
      mutedNotificationKinds: row?.mutedNotificationKinds ?? [],
      slaTargets,
    };
  }

  @Get("notification-prefs")
  async notificationPrefs(@CurrentUser() user: AuthenticatedUser) {
    const [legacyRow, prefRows] = await Promise.all([
      this.db
        .select({ mutedNotificationKinds: users.mutedNotificationKinds })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1),
      this.db
        .select({ kind: notificationPrefs.kind, channels: notificationPrefs.channels })
        .from(notificationPrefs)
        .where(eq(notificationPrefs.userId, user.id)),
    ]);
    // Channels map per kind: defaults are ["in_app","email"] when no row.
    const channelsByKind: Record<string, string[]> = {};
    for (const r of prefRows) channelsByKind[r.kind] = r.channels;
    return {
      kinds: NOTIFICATION_KINDS,
      // Legacy muted-list still surfaced so the existing UI keeps working.
      muted: legacyRow[0]?.mutedNotificationKinds ?? [],
      channels: channelsByKind,
    };
  }

  @Put("notification-prefs")
  @Audited({ action: "user.notificationPrefs.update", resourceType: "user" })
  async updateNotificationPrefs(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = z
      .object({
        muted: z.array(z.string().min(1).max(64)).max(64).optional(),
        // Per-kind delivery channels: empty array = "off", ["in_app"] only,
        // ["email"] only, or both. Missing key = use defaults.
        channels: z
          .record(z.array(z.enum(["in_app", "email"])).max(2))
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const allowed = new Set<string>(NOTIFICATION_KINDS as readonly string[]);

    if (parsed.data.muted !== undefined) {
      const clean = Array.from(
        new Set(parsed.data.muted.filter((k) => allowed.has(k))),
      );
      await this.db
        .update(users)
        .set({ mutedNotificationKinds: clean, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    if (parsed.data.channels !== undefined) {
      for (const [kind, channels] of Object.entries(parsed.data.channels)) {
        if (!allowed.has(kind)) continue;
        const dedupChannels = Array.from(new Set(channels));
        await this.db
          .insert(notificationPrefs)
          .values({ userId: user.id, kind, channels: dedupChannels })
          .onConflictDoUpdate({
            target: [notificationPrefs.userId, notificationPrefs.kind],
            set: { channels: dedupChannels, updatedAt: new Date() },
          });
      }
    }

    return { ok: true };
  }

  @Post("change-password")
  @SessionOnly()
  @Audited({ action: "user.changePassword", resourceType: "user" })
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { newPassword } = changePasswordBody.parse(body);
    if (newPassword === "admin") {
      throw new BadRequestException("Choose a password other than the default");
    }
    const hash = await this.auth.hashPassword(newPassword);
    await this.db
      .insert(credentials)
      .values({ userId: user.id, passwordHash: hash })
      .onConflictDoUpdate({
        target: credentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
    await this.db
      .update(users)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    this.auth.invalidateUser(user.id);
    return { ok: true };
  }

  @Patch()
  @SessionOnly()
  @Audited({ action: "user.profile.update", resourceType: "user" })
  async updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = updateProfileBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const patch: {
      name?: string;
      email?: string;
      pageWidth?: (typeof PAGE_WIDTH_VALUES)[number];
      pageWidthPx?: number | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.pageWidth !== undefined) {
      patch.pageWidth = parsed.data.pageWidth;
      // Blank the px cap whenever the mode leaves "custom" — it has no meaning
      // in any other mode and we'd rather not leak stale values back to the UI.
      if (parsed.data.pageWidth !== "custom" && parsed.data.pageWidthPx === undefined) {
        patch.pageWidthPx = null;
      }
    }
    if (parsed.data.pageWidthPx !== undefined) patch.pageWidthPx = parsed.data.pageWidthPx;

    if (parsed.data.email !== undefined && parsed.data.email !== user.email) {
      // Reject anything that isn't either a real email or our local "<user>@local"
      // convention. We deliberately stay tolerant of "@local" so this stays
      // useful for self-hosted installs without an SMTP-bound identity.
      const e = parsed.data.email;
      const valid = /^[^\s@]+@[^\s@]+$/.test(e);
      if (!valid) throw new BadRequestException("Invalid email format");
      const [taken] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, e), ne(users.id, user.id)))
        .limit(1);
      if (taken) throw new ConflictException("That email is already in use");
      patch.email = e;
    }

    const [updated] = await this.db
      .update(users)
      .set(patch)
      .where(eq(users.id, user.id))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        pageWidth: users.pageWidth,
        pageWidthPx: users.pageWidthPx,
      });
    this.auth.invalidateUser(user.id);
    return updated;
  }
}
