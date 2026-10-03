import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException, Logger } from "@nestjs/common";
import { eq, asc, inArray, and, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  users,
  credentials,
  groups,
  groupMemberships,
  accounts,
} from "../db/schema";
import { AuthService } from "../auth/auth.service";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MailerService } from "../mailer/mailer.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { renderEmail } from "../mailer/templates";
import { AuthTokensService } from "../auth-tokens/auth-tokens.service";
import { DEFAULT_GROUPS, type ApprovalStatus } from "@church/shared";

/** Lowercase domain portion of an email, or "" if malformed. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

export type ProvisionResult = "approved" | "pending" | "rejected" | "deleted";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly mailer: MailerService,
    private readonly realtime: RealtimeGateway,
    private readonly authTokens: AuthTokensService,
  ) {}

  async list() {
    const rows = await this.db.select().from(users).orderBy(asc(users.email));
    // "External" = the account signed in via an OAuth provider (a row in
    // `accounts`), as opposed to a locally-created credentials account.
    const linked = await this.db.selectDistinct({ userId: accounts.userId }).from(accounts);
    const externalIds = new Set(linked.map((a) => a.userId));
    return rows.map((r) => ({ ...r, isExternal: externalIds.has(r.id) }));
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new NotFoundException("User not found");
    return row;
  }

  async create(input: {
    email: string;
    displayName: string;
    password?: string;
    /** Initial groups (by name) — typically just "user" or "admin". */
    groupNames?: string[];
    /**
     * Passwordless invite mode: create with no credentials and email the user a
     * one-time link to set their own password. When true, `password` /
     * `sendWelcomeEmail` are ignored.
     */
    sendInvite?: boolean;
    /** Force /change-password on first sign-in. Defaults false. */
    mustChangePassword?: boolean;
    /** Email the new user a "get started" sign-in link (password mode). */
    sendWelcomeEmail?: boolean;
    /** Public origin (window.location.origin) for the welcome link. */
    appOrigin?: string;
  }) {
    const [existing] = await this.db
      .select({ id: users.id, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing) {
      throw new ConflictException(
        existing.deletedAt
          ? "This email belongs to a deleted account. Restore it from the Deleted tab instead."
          : "Email already in use",
      );
    }

    const [user] = await this.db
      .insert(users)
      .values({
        email: input.email,
        name: input.displayName,
        isActive: true,
        mustChangePassword: input.mustChangePassword === true,
      })
      .returning();
    if (!user) throw new Error("Insert failed");

    if (input.password) {
      const hash = await this.auth.hashPassword(input.password);
      await this.db.insert(credentials).values({ userId: user.id, passwordHash: hash });
    }

    if (input.groupNames?.length) {
      const groupRows = await this.db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(inArray(groups.name, input.groupNames));
      if (groupRows.length) {
        await this.db
          .insert(groupMemberships)
          .values(groupRows.map((g) => ({ groupId: g.id, userId: user.id })))
          .onConflictDoNothing();
      }
    }

    if (input.sendInvite) {
      // Passwordless: email a one-time link to /set-password so the user picks
      // their own. Best-effort — the token row is created regardless of SMTP,
      // and an admin can re-issue from the user's row if delivery fails.
      try {
        await this.authTokens.issue("invite", user.id, input.appOrigin);
      } catch (err) {
        this.logger.warn(`invite issue failed for ${user.email}: ${(err as Error).message}`);
      }
    } else if (input.sendWelcomeEmail) {
      void this.sendWelcomeEmail(user.email, {
        appOrigin: input.appOrigin,
        mustChangePassword: input.mustChangePassword === true,
      });
    }

    return user;
  }

  /**
   * Re-send the welcome ("get started") email to an existing user — e.g. when
   * the original send was lost because SMTP was misconfigured at create time.
   * Best-effort like the create-time send; enqueues via the mailer and resolves
   * regardless of delivery. Refuses for soft-deleted accounts.
   */
  async resendWelcomeEmail(userId: string, appOrigin?: string): Promise<{ ok: true }> {
    const user = await this.getById(userId);
    if (user.deletedAt) {
      throw new BadRequestException("Cannot send a welcome email to a deleted account.");
    }
    await this.sendWelcomeEmail(user.email, {
      appOrigin,
      mustChangePassword: user.mustChangePassword,
    });
    return { ok: true };
  }

  /**
   * Best-effort "your account is ready" email with a sign-in link. The link's
   * base is the `site.url` setting (falling back to APP_URL, then the admin's
   * browser origin); if none is known it degrades to a relative path the
   * recipient can still read. Never throws — account creation has already
   * succeeded by the time this runs.
   */
  private async sendWelcomeEmail(
    email: string,
    opts: { appOrigin?: string; mustChangePassword: boolean },
  ): Promise<void> {
    try {
      const siteNameRaw = await this.settings.get("site.name");
      const siteName = typeof siteNameRaw === "string" && siteNameRaw ? siteNameRaw : "Church Dashboard";
      // `site.url` (operator-set) wins over the admin's browser origin so the
      // link works in the recipient's inbox, not just on the admin's network.
      const origin = await this.settings.publicBaseUrl(opts.appOrigin);
      const link = `${origin}/signin`;
      const rendered = renderEmail({
        siteName,
        title: `Welcome to ${siteName}`,
        body:
          `An account has been created for you on ${siteName}. Click below to sign in and get started.` +
          (opts.mustChangePassword
            ? " You'll be asked to choose a new password the first time you sign in."
            : ""),
        cta: { label: "Get started", href: link },
      });
      await this.mailer.sendBestEffort({
        to: email,
        subject: `Welcome to ${siteName}`,
        text: rendered.text,
        html: rendered.html,
      });
    } catch (err) {
      this.logger.warn(`sendWelcomeEmail failed: ${(err as Error).message}`);
    }
  }

  async update(id: string, input: { displayName?: string; isActive?: boolean; image?: string | null }) {
    const [row] = await this.db
      .update(users)
      .set({
        ...(input.displayName !== undefined ? { name: input.displayName } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException("User not found");
    this.auth.invalidateUser(id);
    return row;
  }

  /**
   * Soft-delete: tombstone the row instead of removing it. The user's authored
   * content (notes, tickets, wiki, audit_log attribution) and satellite rows
   * (credentials, group memberships, totp) are deliberately left intact so the
   * account can be restored seamlessly and the audit trail survives. The email
   * stays locked to this row (the UNIQUE constraint is unchanged), so recovery
   * is via restore() rather than re-creation. is_active is also cleared so the
   * existing is_active gates lock the account out immediately.
   */
  async delete(id: string) {
    const [row] = await this.db
      .update(users)
      .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException("User not found");
    this.auth.invalidateUser(id);
    return row;
  }

  /**
   * Permanently remove a user row. Irreversible — gated to SITE_ADMIN in the
   * controller and only allowed once the account is already soft-deleted, so a
   * live user can never be purged in one step. Inbound FKs handle the rest:
   * CASCADE rows (credentials, sessions, group memberships, owned notes/tickets/
   * wiki, etc.) are removed, SET-NULL rows (audit_log actor, ticket assignee,
   * attachment uploader, etc.) are detached. Useful for resetting auth test
   * state. Re-creating the same email becomes possible again afterwards.
   */
  async hardDelete(id: string) {
    const existing = await this.getById(id); // throws NotFound if missing
    if (!existing.deletedAt) {
      throw new BadRequestException(
        "Only soft-deleted users can be permanently deleted. Delete the user first.",
      );
    }
    const [row] = await this.db.delete(users).where(eq(users.id, id)).returning();
    if (!row) throw new NotFoundException("User not found");
    this.auth.invalidateUser(id);
    return row;
  }

  /** Reverse a soft-delete: clear the tombstone and re-enable sign-in. */
  async restore(id: string) {
    const [row] = await this.db
      .update(users)
      .set({ deletedAt: null, isActive: true, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException("User not found");
    this.auth.invalidateUser(id);
    return row;
  }

  /**
   * Idempotent: if the user has no group memberships yet, add them to the
   * default `user` group. Used by the OAuth provisioning hook so freshly-
   * created Google users land with the baseline permission set instead of
   * locked out.
   */
  async ensureDefaultGroup(userId: string): Promise<{ granted: boolean }> {
    const existing = await this.db
      .select({ groupId: groupMemberships.groupId })
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, userId))
      .limit(1);
    if (existing.length) return { granted: false };

    const [defaultGroup] = await this.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.name, DEFAULT_GROUPS.USER))
      .limit(1);
    if (!defaultGroup) {
      // Seed hasn't run, or the group was deleted — refuse to invent one.
      throw new Error(`Default group "${DEFAULT_GROUPS.USER}" not found in DB`);
    }
    await this.db
      .insert(groupMemberships)
      .values({ groupId: defaultGroup.id, userId })
      .onConflictDoNothing();
    this.auth.invalidateUser(userId);
    return { granted: true };
  }

  /** Set a user's approval gate and drop their cached auth record. */
  async setApprovalStatus(userId: string, status: ApprovalStatus): Promise<void> {
    await this.db
      .update(users)
      .set({ approvalStatus: status, updatedAt: new Date() })
      .where(eq(users.id, userId));
    this.auth.invalidateUser(userId);
  }

  private async hasAnyGroup(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ groupId: groupMemberships.groupId })
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, userId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Decide what happens to a user who just authenticated via OAuth, and apply
   * the decision (default group + approval gate) once the user row exists.
   *
   * Called TWICE per OAuth sign-in by the web Auth.js layer, because of the v5
   * ordering: the `signIn` callback runs BEFORE the adapter persists a new user
   * row (to authorise the sign-in), and `events.signIn` runs AFTER persistence.
   * Writes (ensureDefaultGroup/setApprovalStatus) reference users.id via a FK,
   * so they must not run until the row exists — otherwise they hit
   * `group_memberships_user_id_users_id_fk`. We therefore guard every write
   * behind `userExists`: the pre-persistence call returns the decision only
   * (for allow/deny + the JWT), and the post-persistence call does the grant.
   * Idempotent — safe to call repeatedly (hasAnyGroup short-circuits).
   *
   * Google gating (other providers are always approved):
   *   - already in a group         -> approved (an admin decision stands; never re-evaluate)
   *   - email matches workspace domain -> approved + default group
   *   - no workspace domain, approval off -> approved + default group (open mode, legacy)
   *   - workspace domain set, approval off, no match -> rejected (domain-locked)
   *   - approval on, no match       -> pending (no group; admin must approve)
   */
  async provisionOAuthUser(input: {
    userId: string;
    email: string;
    provider: string;
  }): Promise<{ status: ProvisionResult }> {
    const [existing] = await this.db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    // A soft-deleted account must never be resurrected by a returning OAuth
    // identity (its accounts row still points here). Deny before anything else.
    if (existing?.deletedAt) return { status: "deleted" };
    const userExists = existing !== undefined;

    if (input.provider !== "google") {
      if (userExists) {
        await this.ensureDefaultGroup(input.userId).catch(() => undefined);
        await this.setApprovalStatus(input.userId, "approved");
      }
      return { status: "approved" };
    }

    // Already provisioned (has a group) — leave the admin's decision intact.
    if (userExists && (await this.hasAnyGroup(input.userId))) {
      return { status: "approved" };
    }

    const domainRaw = await this.settings.get("google.workspace_domain");
    const domain = (typeof domainRaw === "string" ? domainRaw : "").trim().toLowerCase();
    const approval = (await this.settings.get("google.allow_external_with_approval")) === true;
    const inWorkspace = domain !== "" && emailDomain(input.email) === domain;

    if (inWorkspace) {
      if (userExists) {
        await this.ensureDefaultGroup(input.userId);
        await this.setApprovalStatus(input.userId, "approved");
      }
      return { status: "approved" };
    }

    // External account (or no workspace domain configured).
    if (!approval) {
      if (domain !== "") return { status: "rejected" }; // domain-locked, no external sign-in
      // Open mode: no domain + no approval gate = auto-accept (legacy default).
      if (userExists) {
        await this.ensureDefaultGroup(input.userId);
        await this.setApprovalStatus(input.userId, "approved");
      }
      return { status: "approved" };
    }

    // Approval mode on, external account -> pending (no group, no access).
    if (userExists) {
      await this.setApprovalStatus(input.userId, "pending");
      void this.notifyAdminsOfPending(input.userId, input.email);
    }
    return { status: "pending" };
  }

  /** Admin action: grant a pending user the default group and clear the gate. */
  async approve(userId: string): Promise<{ ok: true }> {
    await this.getById(userId);
    await this.ensureDefaultGroup(userId);
    await this.setApprovalStatus(userId, "approved");
    // Nudge any open /pending tab for this user to advance to the dashboard
    // without them having to refresh. Best-effort — the page also polls + has a
    // manual re-check, so a missed socket event is not fatal.
    this.realtime.toUser(userId, "access:granted", { at: Date.now() });
    return { ok: true };
  }

  /** Admin action: deny a pending user. Deactivates so they can't sign in. */
  async reject(userId: string): Promise<{ ok: true }> {
    await this.update(userId, { isActive: false });
    return { ok: true };
  }

  /** Best-effort fan-out telling every admin a new account needs approval. */
  private async notifyAdminsOfPending(userId: string, email: string): Promise<void> {
    try {
      const [adminGroup] = await this.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.name, DEFAULT_GROUPS.ADMIN))
        .limit(1);
      if (!adminGroup) return;
      const admins = await this.db
        .select({ userId: groupMemberships.userId })
        .from(groupMemberships)
        .where(eq(groupMemberships.groupId, adminGroup.id));
      if (admins.length === 0) return;
      await this.notifications.createMany(
        admins.map((a) => ({
          recipientUserId: a.userId,
          kind: "user.approval_pending" as const,
          title: "New account awaiting approval",
          body: `${email} signed in with Google and needs admin approval before they can access anything.`,
          link: "/admin/users",
          excludeActorId: userId,
        })),
      );
    } catch (err) {
      this.logger.warn(`notifyAdminsOfPending failed: ${(err as Error).message}`);
    }
  }

  /** Replace the user's group memberships with the given list (by group id). */
  async setGroups(userId: string, groupIds: string[]): Promise<{ ok: true }> {
    await this.getById(userId);
    await this.db.delete(groupMemberships).where(eq(groupMemberships.userId, userId));
    if (groupIds.length) {
      await this.db
        .insert(groupMemberships)
        .values(groupIds.map((groupId) => ({ groupId, userId })));
    }
    this.auth.invalidateUser(userId);
    return { ok: true };
  }

  /**
   * Admin-driven password reset for another account. Upserts the credentials
   * row (so accounts that signed in via OAuth and never had a local password
   * get one) and optionally flags the user to change it on next sign-in.
   */
  async adminResetPassword(
    userId: string,
    password: string,
    mustChangePassword: boolean,
  ): Promise<{ ok: true }> {
    await this.getById(userId);
    const hash = await this.auth.hashPassword(password);
    await this.db
      .insert(credentials)
      .values({ userId, passwordHash: hash })
      .onConflictDoUpdate({
        target: credentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
    await this.db
      .update(users)
      .set({ mustChangePassword, updatedAt: new Date() })
      .where(eq(users.id, userId));
    this.auth.invalidateUser(userId);
    return { ok: true };
  }

  /** List the user's group membership ids. */
  async getAssignments(userId: string) {
    await this.getById(userId);
    const groupRows = await this.db
      .select({ groupId: groupMemberships.groupId })
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, userId));
    return { groupIds: groupRows.map((g) => g.groupId) };
  }
}
