import { describe, expect, it } from "vitest";
import {
  domainOf,
  googleSignInDecision,
  isSingleTenant,
  isWorkspaceMember,
  microsoftSignInDecision,
} from "@church/shared";

describe("googleSignInDecision", () => {
  it("accepts a verified address", () => {
    expect(googleSignInDecision({ email_verified: true }).ok).toBe(true);
  });
  it("refuses an unverified, missing or non-boolean claim", () => {
    expect(googleSignInDecision({ email_verified: false }).ok).toBe(false);
    expect(googleSignInDecision({}).ok).toBe(false);
    expect(googleSignInDecision({ email_verified: "true" }).ok).toBe(false);
    expect(googleSignInDecision(undefined).ok).toBe(false);
  });
});

describe("isWorkspaceMember", () => {
  const base = { email: "Sam@Church.org", domain: "church.org" };
  it("needs the hd claim to match when it is sent", () => {
    expect(isWorkspaceMember({ ...base, hostedDomain: "church.org" })).toBe(true);
    expect(isWorkspaceMember({ ...base, hostedDomain: "" })).toBe(false);
    expect(isWorkspaceMember({ ...base, hostedDomain: "other.org" })).toBe(false);
  });
  it("falls back to the address when the caller did not send hd (older web build)", () => {
    expect(isWorkspaceMember(base)).toBe(true);
  });
  it("never matches a different address domain or an unset workspace", () => {
    expect(isWorkspaceMember({ email: "x@evil.org", domain: "church.org", hostedDomain: "church.org" })).toBe(false);
    expect(isWorkspaceMember({ email: "x@church.org", domain: "", hostedDomain: "" })).toBe(false);
  });
});

describe("microsoftSignInDecision", () => {
  const upn = (d: string) => ({ preferred_username: `sam@${d}`, email: "sam@church.org" });

  it("refuses a shared endpoint with no allowed domains", () => {
    for (const tenant of ["common", "organizations", "consumers", "Common", ""]) {
      expect(microsoftSignInDecision(upn("church.org"), { tenant, allowedDomains: [] }).ok).toBe(false);
    }
  });
  it("lets a single tenant in without a list", () => {
    expect(microsoftSignInDecision(upn("church.org"), { tenant: "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab", allowedDomains: [] }).ok).toBe(true);
    expect(microsoftSignInDecision(upn("church.org"), { tenant: "church.onmicrosoft.com", allowedDomains: [] }).ok).toBe(true);
  });
  it("judges the list on the user principal name, not on the editable email claim", () => {
    const spoof = { preferred_username: "mallory@evil.example", email: "pastor@church.org" };
    expect(microsoftSignInDecision(spoof, { tenant: "common", allowedDomains: ["church.org"] }).ok).toBe(false);
    expect(microsoftSignInDecision(upn("church.org"), { tenant: "common", allowedDomains: ["church.org"] }).ok).toBe(true);
  });
  it("uses the email claim only for a single tenant with no principal name", () => {
    const emailOnly = { email: "sam@church.org" };
    expect(microsoftSignInDecision(emailOnly, { tenant: "common", allowedDomains: ["church.org"] }).ok).toBe(false);
    expect(microsoftSignInDecision(emailOnly, { tenant: "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab", allowedDomains: ["church.org"] }).ok).toBe(true);
  });
  it("matches the list case-insensitively and ignores blanks", () => {
    expect(microsoftSignInDecision(upn("CHURCH.org"), { tenant: "common", allowedDomains: [" Church.Org ", ""] }).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("domainOf", () => {
    expect(domainOf("a@B.com")).toBe("b.com");
    expect(domainOf("nope")).toBe("");
    expect(domainOf(null)).toBe("");
  });
  it("isSingleTenant", () => {
    expect(isSingleTenant("common")).toBe(false);
    expect(isSingleTenant(undefined)).toBe(false);
    expect(isSingleTenant("contoso.onmicrosoft.com")).toBe(true);
  });
});
