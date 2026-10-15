/**
 * Who may sign in through Google or Microsoft. Pure functions so the rules are unit-tested
 * (`apps/api/test/oauth-policy.test.ts`); the Auth.js `signIn` callback in the web app calls them.
 */

export type OAuthDecision = { ok: true } | { ok: false; reason: string };

/** Domain part of an email-like string, lower-cased; "" when there is none. */
export function domainOf(value: string | null | undefined): string {
  if (!value) return "";
  const at = value.lastIndexOf("@");
  return at < 0 ? "" : value.slice(at + 1).trim().toLowerCase();
}

/**
 * Google: the address must be one Google has verified. Without that, an account created for an address
 * its creator never proved they own would pass the workspace-domain check on its `email` alone.
 */
export function googleSignInDecision(profile: { email_verified?: unknown } | null | undefined): OAuthDecision {
  if (profile?.email_verified !== true) {
    return { ok: false, reason: "Google has not verified this account's email address" };
  }
  return { ok: true };
}

const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

/** True when `tenant` names one directory (a tenant id or domain) rather than one of Microsoft's shared endpoints. */
export function isSingleTenant(tenant: string | null | undefined): boolean {
  const t = (tenant ?? "").trim().toLowerCase();
  return t !== "" && !MULTI_TENANT.has(t);
}

/**
 * Microsoft Entra: a shared endpoint (`common`, `organizations`, `consumers`) lets in accounts from ANY
 * directory, so it needs an allowed-domain list; a single tenant already limits sign-in to its members.
 *
 * The domain is judged on the user principal name (`preferred_username`), which belongs to a domain the
 * account's own directory has verified. The `email` claim is a free attribute that the owner of any
 * directory can set to someone else's address, so it is only consulted for a single tenant, where every
 * account comes from the directory we chose.
 */
export function microsoftSignInDecision(
  profile: { email?: string | null; preferred_username?: string | null } | null | undefined,
  cfg: { tenant: string; allowedDomains: readonly string[] },
): OAuthDecision {
  const allowed = cfg.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  const single = isSingleTenant(cfg.tenant);
  if (allowed.length === 0) {
    return single
      ? { ok: true }
      : {
          ok: false,
          reason:
            "Microsoft sign-in is open to any directory because no allowed email domains are set and the tenant is a shared endpoint. Set the allowed domains or a specific tenant id in the Microsoft settings.",
        };
  }
  const upnDomain = domainOf(profile?.preferred_username);
  const emailDomainValue = domainOf(profile?.email);
  const candidate = upnDomain || (single ? emailDomainValue : "");
  if (!candidate || !allowed.includes(candidate)) {
    return { ok: false, reason: `The account's domain "${candidate || "unknown"}" is not in the allowed list` };
  }
  return { ok: true };
}

/**
 * Whether a Google account counts as a member of the workspace `domain` (and so is approved on sight).
 * The `hd` claim is present only for accounts a Workspace domain manages; the address alone is not proof,
 * since a consumer account can carry any verified address. `hostedDomain` of `undefined` means the caller
 * did not send it (a web node still on an older build during a rolling upgrade), in which case the address
 * decides, as before.
 */
export function isWorkspaceMember(input: { email: string; domain: string; hostedDomain?: string }): boolean {
  const domain = input.domain.trim().toLowerCase();
  if (domain === "" || domainOf(input.email) !== domain) return false;
  if (input.hostedDomain === undefined) return true;
  return input.hostedDomain.trim().toLowerCase() === domain;
}
