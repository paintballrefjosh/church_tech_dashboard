import { Controller, Get, Post, Put, Patch, Delete, Param, Body, BadRequestException, Req } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, createLocalUserSchema, updateUserSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Public } from "../auth/public.decorator";
import { assertInternalCaller } from "../auth/internal-token";
import { Audited } from "../audit/audit.decorator";
import { UsersService } from "./users.service";

const createBody = createLocalUserSchema.extend({
  groupNames: z.array(z.string().min(1).max(120)).max(20).optional(),
  // Public origin the admin is currently on (window.location.origin), used to
  // build an absolute "get started" link in the welcome email without baking a
  // hostname server-side. Optional; falls back to APP_URL / a relative path.
  appOrigin: z.string().url().optional(),
});
const ensureDefaultGroupBody = z.object({ userId: z.string().uuid() });
const oauthProvisionBody = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  provider: z.string().min(1).max(64),
});
const setGroupsBody = z.object({ groupIds: z.array(z.string().uuid()).max(50) });
const resendWelcomeBody = z.object({ appOrigin: z.string().url().optional() });
const adminResetPasswordBody = z.object({
  password: z.string().min(12).max(256),
  mustChangePassword: z.boolean().optional().default(true),
});

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USERS_READ_ANY)
  list() {
    return this.users.list();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.USERS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.users.getById(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.create", resourceType: "user" })
  async create(@Body() body: unknown) {
    const parsed = createBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const d = parsed.data;
    if (!d.sendInvite && !d.password) {
      throw new BadRequestException("A password is required when not sending an invite link.");
    }
    return this.users.create({
      email: d.email,
      displayName: d.displayName,
      // Invite mode is passwordless — the user sets their own via the link.
      password: d.sendInvite ? undefined : d.password,
      groupNames: d.groupNames,
      sendInvite: d.sendInvite,
      mustChangePassword: d.mustChangePassword,
      sendWelcomeEmail: d.sendWelcomeEmail,
      appOrigin: d.appOrigin,
    });
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.update", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.update(id, {
      displayName: parsed.data.displayName,
      isActive: parsed.data.isActive,
      image: parsed.data.avatarUrl ?? undefined,
    });
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.delete", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id") id: string) {
    return this.users.delete(id);
  }

  @Post(":id/restore")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.restore", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async restore(@Param("id") id: string) {
    return this.users.restore(id);
  }

  @Post(":id/resend-welcome")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.resendWelcome", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async resendWelcome(@Param("id") id: string, @Body() body: unknown) {
    const parsed = resendWelcomeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.resendWelcomeEmail(id, parsed.data.appOrigin);
  }

  /**
   * Permanently delete a soft-deleted user. Irreversible, so gated to the
   * highest privilege (SITE_ADMIN) and only valid on an already-soft-deleted
   * account. Primarily for resetting auth/test state.
   */
  @Post(":id/hard-delete")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  @Audited({ action: "user.hardDelete", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async hardDelete(@Param("id") id: string) {
    return this.users.hardDelete(id);
  }

  // ---- group assignment ----

  @Get(":id/assignments")
  @RequirePermissions(PERMISSIONS.USERS_READ_ANY)
  assignments(@Param("id") id: string) {
    return this.users.getAssignments(id);
  }

  @Put(":id/groups")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.setGroups", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async setGroups(@Param("id") id: string, @Body() body: unknown) {
    const parsed = setGroupsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.setGroups(id, parsed.data.groupIds);
  }

  // ---- pending-approval workflow (external Google accounts) ----

  @Post(":id/approve")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.approve", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async approve(@Param("id") id: string) {
    return this.users.approve(id);
  }

  @Post(":id/reject")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.reject", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async reject(@Param("id") id: string) {
    return this.users.reject(id);
  }

  /**
   * Admin force-reset of another user's password. Defaults to setting
   * mustChangePassword=true so the recipient is bounced through
   * /change-password on next sign-in. Audit log captures who did it.
   */
  @Post(":id/password")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "user.adminResetPassword", resourceType: "user", resourceIdFromParams: (p) => p.id ?? null })
  async adminResetPassword(@Param("id") id: string, @Body() body: unknown) {
    const parsed = adminResetPasswordBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.adminResetPassword(id, parsed.data.password, parsed.data.mustChangePassword);
  }

  // ---- OAuth provisioning hook ----

  /**
   * Called by the web service (Auth.js `events.createUser`) right after the
   * DrizzleAdapter has inserted a row for a fresh OAuth sign-in. Idempotent —
   * a no-op when the user is already in at least one group.
   *
   * @Public because the web service has no session at this point. Caller must
   * present a valid X-Internal-Token (sha256("internal-api:" + AUTH_SECRET));
   * the Caddyfile also 404s this path on the public proxy.
   */
  @Public()
  @Post("ensure-default-group")
  @Audited({ action: "user.ensureDefaultGroup", resourceType: "user" })
  async ensureDefaultGroup(@Req() req: { headers?: Record<string, string | string[] | undefined> }, @Body() body: unknown) {
    assertInternalCaller(req);
    const parsed = ensureDefaultGroupBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.ensureDefaultGroup(parsed.data.userId);
  }

  /**
   * OAuth provisioning decision for a just-authenticated user. Called by the
   * web Auth.js `signIn` callback with the provider + verified email; returns
   * whether the user is approved (and grouped), pending admin approval, or
   * rejected (sign-in should be refused). Replaces the old blanket
   * ensure-default-group call so external Google accounts can be gated.
   *
   * @Public — the web service has no session here; it presents X-Internal-Token
   * (sha256("internal-api:" + AUTH_SECRET)) and the Caddyfile 404s this path on
   * the public proxy.
   */
  @Public()
  @Post("oauth-provision")
  @Audited({ action: "user.oauthProvision", resourceType: "user" })
  async oauthProvision(
    @Req() req: { headers?: Record<string, string | string[] | undefined> },
    @Body() body: unknown,
  ) {
    assertInternalCaller(req);
    const parsed = oauthProvisionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.users.provisionOAuthUser(parsed.data);
  }
}
