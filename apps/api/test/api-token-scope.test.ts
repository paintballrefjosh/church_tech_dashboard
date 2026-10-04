import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, PERMISSIONS, permissionsFor } from "@church/shared";
import { isReadMethod, scopeUserToToken } from "../src/auth/api-token-scope";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";

function user(access: AuthenticatedUser["access"], permissions?: string[]): AuthenticatedUser {
  const perms =
    permissions ?? [...new Set(Object.entries(access).flatMap(([m, t]) => permissionsFor(m, t)))];
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: "owner@local",
    name: "Owner",
    isActive: true,
    totpEnabled: false,
    mustChangePassword: false,
    approvalStatus: "approved",
    groups: ["user"],
    permissions: perms,
    access,
  };
}

describe("isReadMethod", () => {
  it("allows GET, HEAD and OPTIONS in any case", () => {
    for (const m of ["GET", "head", "Options"]) expect(isReadMethod(m)).toBe(true);
  });
  it("treats a missing method as GET", () => {
    expect(isReadMethod(undefined)).toBe(true);
  });
  it("refuses every mutating method", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(isReadMethod(m)).toBe(false);
  });
});

describe("scopeUserToToken", () => {
  it("leaves an all-modules token with the owner's full access", () => {
    const owner = user({ wiki: "admin", tickets: "user" });
    const scoped = scopeUserToToken(owner, { readOnly: false, modules: null });
    expect(scoped.permissions).toEqual(owner.permissions);
    expect(scoped.access).toEqual(owner.access);
  });

  it("keeps only the chosen modules' permissions and tiers", () => {
    const owner = user({ wiki: "moderator", tickets: "admin", notes: "user" });
    const scoped = scopeUserToToken(owner, { readOnly: false, modules: ["wiki"] });
    expect(new Set(scoped.permissions)).toEqual(new Set(permissionsFor("wiki", "moderator")));
    expect(scoped.access).toEqual({ wiki: "moderator" });
    expect(scoped.permissions).not.toContain(PERMISSIONS.TICKETS_ADMIN);
  });

  it("never grants more than the owner has", () => {
    // Owner only has the wiki user tier; a wiki token must not pick up wiki:admin.
    const owner = user({ wiki: "user" });
    const scoped = scopeUserToToken(owner, { readOnly: false, modules: ["wiki", "tickets"] });
    expect(scoped.permissions).not.toContain(PERMISSIONS.WIKI_ADMIN);
    expect(scoped.permissions).not.toContain(PERMISSIONS.TICKETS_READ_OWN);
    expect(scoped.access).toEqual({ wiki: "user" });
  });

  it("cuts an admin owner down to the token's modules", () => {
    const owner = user({ wiki: "admin", admin: "admin", monitoring: "admin" }, [...ALL_PERMISSIONS]);
    const scoped = scopeUserToToken(owner, { readOnly: false, modules: ["monitoring"] });
    expect(new Set(scoped.permissions)).toEqual(new Set(permissionsFor("monitoring", "admin")));
    expect(scoped.permissions).not.toContain(PERMISSIONS.USER_ADMIN);
    expect(scoped.permissions).not.toContain(PERMISSIONS.SITE_ADMIN);
  });

  it("does not mutate the owner record (it is shared through the user cache)", () => {
    const owner = user({ wiki: "admin", tickets: "admin" });
    const before = structuredClone(owner);
    scopeUserToToken(owner, { readOnly: true, modules: ["wiki"] });
    expect(owner).toEqual(before);
  });
});
