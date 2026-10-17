import { Controller, Get, Put, Post, Patch, Delete, Param, Body, BadRequestException, ConflictException, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { NOTIFICATION_KINDS, TICKET_PRIORITIES, type TicketSlaMap } from "@church/shared";
import { CurrentUser, SessionId, type AuthenticatedUser } from "./current-user.decorator";
import { SessionsService } from "./sessions.service";
import { AuthService } from "./auth.service";
import { SettingsService } from "../settings/settings.service";
import { DB, type Db } from "../db/db.module";
import { users, credentials, notificationPrefs } from "../db/schema";
import { Audited } from "../audit/audit.decorator";
import { SessionOnly } from "./session-only.decorator";

const changePasswordBody = z.object({
  newPassword: z.string().min(8).max(256),
  // Required unless the account is being forced to change a password it was just given (see changePassword).
  currentPassword: z.string().max(256).optional(),
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
    private readonly sessions: SessionsService,
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
          .record(z.array(z.enum(["in_app", "email", "push"])).max(3))
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
    const { newPassword, currentPassword } = changePasswordBody.parse(body);
    if (newPassword === "admin") {
      throw new BadRequestException("Choose a password other than the default");
    }
    // A session alone must not be enough to take the account over: prove the current password. Not asked when
    // the account was just given a temporary one (the forced change), or has no local password yet (an account
    // that signs in through Google or Microsoft choosing its first one).
    const [existing] = await this.db.select().from(credentials).where(eq(credentials.userId, user.id)).limit(1);
    if (existing && !user.mustChangePassword) {
      if (!currentPassword || !(await this.auth.verifyPassword(existing.passwordHash, currentPassword))) {
        throw new BadRequestException("The current password is not correct");
      }
      if (currentPassword === newPassword) throw new BadRequestException("Choose a password different from the current one");
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
    // Sign every browser out, this one included (the web sends the person to the sign-in page): whoever else
    // held a session on this account loses it.
    await this.auth.revokeSessions(user.id);
    return { ok: true };
  }

  /** The browsers this account is signed in on, newest use first; `current` marks the one asking. */
  @Get("sessions")
  @SessionOnly()
  async listSessions(@CurrentUser() user: AuthenticatedUser, @SessionId() sid: string | null) {
    return { sessions: await this.sessions.list(user.id, sid) };
  }

  /** Sign every other browser out, keeping this one. */
  @Post("sessions/revoke-others")
  @SessionOnly()
  @Audited({ action: "user.sessions.revokeOthers", resourceType: "user" })
  async revokeOtherSessions(@CurrentUser() user: AuthenticatedUser, @SessionId() sid: string | null) {
    return { ok: true, ended: await this.sessions.revokeOthers(user.id, sid) };
  }

  /** Sign out everywhere, this browser included, and every older cookie that has no listed session. */
  @Post("sessions/revoke-all")
  @SessionOnly()
  @Audited({ action: "user.sessions.revokeAll", resourceType: "user" })
  async revokeAllSessions(@CurrentUser() user: AuthenticatedUser) {
    await this.auth.revokeSessions(user.id);
    return { ok: true };
  }

  /** End one session of this account (the id comes from the list, or "current"). Ending the current one signs this browser out. */
  @Delete("sessions/:id")
  @SessionOnly()
  @Audited({ action: "user.session.revoke", resourceType: "user_session", resourceIdFromParams: (p) => p.id ?? null })
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @SessionId() sid: string | null, @Param("id") id: string) {
    // "current" is this browser's own session (the sign-out button uses it, as the page does not know its id).
    if (id === "current") {
      if (!sid) throw new NotFoundException("This browser has no listed session");
      await this.sessions.revokeCurrent(user.id, sid);
      return { ok: true };
    }
    const target = /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
    if (!target) throw new NotFoundException("No such session");
    const ended = await this.sessions.revoke(user.id, target);
    if (!ended) throw new NotFoundException("No such session");
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

    // Emails are stored lower-case (sign-in lower-cases what is typed, so a mixed-case address would never match),
    // and "taken" is judged without regard to case.
    if (parsed.data.email !== undefined && parsed.data.email.toLowerCase() !== user.email.toLowerCase()) {
      // Reject anything that isn't either a real email or our local "<user>@local"
      // convention. We deliberately stay tolerant of "@local" so this stays
      // useful for self-hosted installs without an SMTP-bound identity.
      const e = parsed.data.email.toLowerCase();
      const valid = /^[^\s@]+@[^\s@]+$/.test(e);
      if (!valid) throw new BadRequestException("Invalid email format");
      const [taken] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(sql`lower(${users.email}) = ${e}`, ne(users.id, user.id)))
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
