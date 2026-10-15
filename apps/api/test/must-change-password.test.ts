import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { enforceMustChangePassword } from "../src/auth/session.guard";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";

const user = (mustChangePassword: boolean) => ({ mustChangePassword }) as AuthenticatedUser;
const call = (u: AuthenticatedUser, method: string, url: string) => () => enforceMustChangePassword(u, { method, url });

describe("must-change-password gate", () => {
  it("lets a normal account do anything", () => {
    expect(call(user(false), "GET", "/api/v1/tickets")).not.toThrow();
    expect(call(user(false), "DELETE", "/api/v1/tickets/1")).not.toThrow();
  });

  it("allows only the profile read and the password change", () => {
    const u = user(true);
    expect(call(u, "GET", "/api/v1/me")).not.toThrow();
    expect(call(u, "GET", "/api/v1/me?x=1")).not.toThrow();
    expect(call(u, "GET", "/api/v1/me/")).not.toThrow();
    expect(call(u, "POST", "/api/v1/me/change-password")).not.toThrow();
  });

  it("refuses reads of everything else (the seeded admin/admin must not browse data)", () => {
    const u = user(true);
    for (const url of ["/api/v1/settings", "/api/v1/tickets", "/api/v1/users", "/api/v1/activity", "/api/v1/me/api-tokens", "/api/v1/audit"]) {
      expect(call(u, "GET", url)).toThrow(ForbiddenException);
    }
  });

  it("refuses writes, including a PATCH to /me", () => {
    const u = user(true);
    expect(call(u, "PATCH", "/api/v1/me")).toThrow(ForbiddenException);
    expect(call(u, "POST", "/api/v1/tickets")).toThrow(ForbiddenException);
    expect(call(u, "POST", "/api/v1/me/change-password/extra")).toThrow(ForbiddenException);
  });
});
