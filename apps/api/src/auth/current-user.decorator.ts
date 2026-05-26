import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  roles: string[]; // role keys
  permissions: string[]; // resolved permission strings
};

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser | null => {
    const req = ctx.switchToHttp().getRequest();
    return req.user ?? null;
  }
);
