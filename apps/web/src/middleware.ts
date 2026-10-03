import { NextResponse, type NextRequest } from "next/server";

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
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
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
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|manifest|icon).*)"],
};
