/**
 * Server-side sign-out for stateless session cookies. Each user row carries `session_version`; the web app
 * stamps the value into the cookie's JWT (`sv`) when it signs the person in. Changing the password, an admin
 * reset, or removing two-factor bumps the row (`AuthService.revokeSessions`), after which every cookie issued
 * earlier no longer matches and is refused. A cookie from before this existed has no `sv` and counts as 0,
 * which is what every account starts with, so nobody is signed out by the upgrade itself.
 *
 * One browser can also be ended on its own: the cookie carries a random session id (`sid`, a `user_sessions` row)
 * and the account's revoked ids ride along with the cached user (`revokedSessions`), so judging a request costs no
 * extra query. A cookie without `sid` (issued before sessions were listed) is not tied to a row.
 */
export function sessionVersionOf(claims: { sv?: unknown } | null | undefined): number {
  const sv = claims?.sv;
  return typeof sv === "number" && Number.isInteger(sv) && sv >= 0 ? sv : 0;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cookie's session id, or null for a cookie that has none (or a malformed one). */
export function sessionIdOf(claims: { sid?: unknown } | null | undefined): string | null {
  const sid = claims?.sid;
  return typeof sid === "string" && SESSION_ID.test(sid) ? sid.toLowerCase() : null;
}

export function sessionIsCurrent(
  claims: { sv?: unknown; sid?: unknown } | null | undefined,
  user: { sessionVersion: number; revokedSessions?: readonly string[] },
): boolean {
  if (sessionVersionOf(claims) !== user.sessionVersion) return false;
  const sid = sessionIdOf(claims);
  return !(sid && user.revokedSessions?.includes(sid));
}
