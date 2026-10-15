/**
 * Server-side sign-out for stateless session cookies. Each user row carries `session_version`; the web app
 * stamps the value into the cookie's JWT (`sv`) when it signs the person in. Changing the password, an admin
 * reset, or removing two-factor bumps the row (`AuthService.revokeSessions`), after which every cookie issued
 * earlier no longer matches and is refused. A cookie from before this existed has no `sv` and counts as 0,
 * which is what every account starts with, so nobody is signed out by the upgrade itself.
 */
export function sessionVersionOf(claims: { sv?: unknown } | null | undefined): number {
  const sv = claims?.sv;
  return typeof sv === "number" && Number.isInteger(sv) && sv >= 0 ? sv : 0;
}

export function sessionIsCurrent(claims: { sv?: unknown } | null | undefined, user: { sessionVersion: number }): boolean {
  return sessionVersionOf(claims) === user.sessionVersion;
}
