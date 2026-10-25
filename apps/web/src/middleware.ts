import { NextResponse, type NextRequest } from "next/server";
import { crossOriginWriteRefused, parseOriginList } from "@church/shared";

const SESSION_COOKIE_CANDIDATES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

const PUBLIC_PATH_PREFIXES = [
  "/signin",
  "/forgot-password",
  "/set-password",
  "/api/auth",
  "/api/health",
  "/_next",
  "/favicon",
  "/manifest",
  "/icon",
  // The service worker script holds nothing private. Behind a sign-in redirect a browser refuses to register it, so a
  // visit before signing in left no worker for push to use.
  "/sw.js",
  // The status page's public copy, when an admin has switched it on (the API answers 404 otherwise).
  "/public-status",
];

/**
 * The page's Content-Security-Policy, with a fresh nonce per request: only scripts that carry it (Next's own,
 * and the theme bootstrap) run, so an injected `<script>` or inline handler does nothing even if one slipped
 * past escaping. `strict-dynamic` lets those scripts load the chunks they need. Styles stay `unsafe-inline`
 * (React sets style attributes, which CSP counts as inline style). Caddy sends a looser baseline on every
 * response too; the browser enforces both, so this stricter one decides for pages.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  // Next reads the nonce from the CSP on the REQUEST and applies it to the scripts it renders.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const proceed = () => {
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set("content-security-policy", csp);
    return res;
  };
  // A change must come from this site's own pages. The route handlers forward to the API server-side, where the
  // browser's Origin no longer reaches the API's own check, so it is judged here (Auth.js guards its routes with its
  // own CSRF token; Next checks Server Actions' origin as well).
  if (!pathname.startsWith("/api/auth/") && crossOriginWriteRefused(req.method, (h) => req.headers.get(h), parseOriginList(process.env.APP_URL))) {
    return new NextResponse("This change did not come from this site's own pages", { status: 403 });
  }
  if (PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return proceed();
  }
  const hasSession = SESSION_COOKIE_CANDIDATES.some((name) => req.cookies.has(name));
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }
  // Pending/approval gating is done in the server components (home page →
  // /pending, /pending verifies via fresh /me, and the API blocks pending
  // users at 403). We deliberately don't decode the JWT here: the cookie can
  // lag the DB (first sign-in, or just after an admin approves), and a
  // token-vs-DB disagreement between middleware and /pending would loop.
  return proceed();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|manifest|icon).*)"],
};
