import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  // "approved" = full member; "pending" = external OAuth user awaiting admin
  // approval, blocked from everything but their own /me. See session.guard.
  approvalStatus: "approved" | "pending";
  groups: string[]; // group names the user is a member of
  permissions: string[]; // resolved permission strings (derived from access)
  // Highest tier the user has per module (across all their groups). The
  // primary user-facing access model; permissions are derived from this via
  // packages/shared/src/modules.ts.
  access: Record<string, "user" | "moderator" | "admin">;
  // Set when the request authenticated with an API token. permissions/access
  // above are then already narrowed to the token's modules (see
  // auth/api-token-scope.ts); readOnly is enforced by SessionGuard.
  apiToken?: { id: string; name: string; readOnly: boolean; modules: string[] | null };
};

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser | null => {
    const req = ctx.switchToHttp().getRequest();
    return req.user ?? null;
  }
);
