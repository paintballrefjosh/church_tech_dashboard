/**
 * Whether a request that changes something came from a page of this site. The session cookie is SameSite=Lax, which
 * stops other SITES but not another origin of the same site (a sibling subdomain): a form there can still post a
 * multipart upload with the cookie attached. Browsers say where a request came from in `Sec-Fetch-Site` (and `Origin`),
 * so a write is refused when either names somewhere else. A request with neither header is not from a browser page (a
 * script, the web's own server-side calls) and is let through: the cookie or token is the credential there.
 *
 * Used by the API's SessionGuard (cookie requests) and by the web's middleware (its route handlers proxy to the API
 * server-side, where the browser's headers no longer reach the API). Pure, so both share it.
 */

type HeaderValue = string | string[] | null | undefined;
export type HeaderGetter = (name: string) => HeaderValue;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function first(v: HeaderValue): string {
  return (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();
}

/** The host names the request was addressed by (`X-Forwarded-Host` and `Host`, either may list several). */
function requestHosts(get: HeaderGetter): string[] {
  return [first(get("x-forwarded-host")), first(get("host"))]
    .flatMap((h) => h.split(","))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether `Origin` (when sent) is this site: the host the request was addressed by, or one of `allowedOrigins`
 * (the `APP_URL` list). No `Origin` is allowed.
 */
export function originMatchesRequest(get: HeaderGetter, allowedOrigins: readonly string[] = []): boolean {
  const origin = first(get("origin"));
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (requestHosts(get).includes(originHost)) return true;
  return allowedOrigins.map((o) => o.trim().replace(/\/$/, "")).includes(origin.replace(/\/$/, ""));
}

/** Parse the `APP_URL` style comma-separated origin list. */
export function parseOriginList(raw: string | undefined | null): string[] {
  return raw ? raw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean) : [];
}

/**
 * Whether a request should be refused as coming from another origin. Reads only: GET/HEAD/OPTIONS are never refused
 * (they must not change anything, and links from elsewhere have to work).
 */
export function crossOriginWriteRefused(
  method: string,
  get: HeaderGetter,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = first(get("sec-fetch-site")).toLowerCase();
  // `same-site` is exactly the case SameSite=Lax lets through: another origin of this site. `none` is the person
  // typing or bookmarking, `same-origin` is this site's own pages.
  if (site === "cross-site") return true;
  if (site === "same-site" && !originMatchesRequest(get, allowedOrigins)) return true;
  if (site === "same-site" && !first(get("origin"))) return true;
  return !originMatchesRequest(get, allowedOrigins);
}
