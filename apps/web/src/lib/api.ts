import { cookies, headers } from "next/headers";
import { CONSISTENCY_COOKIE, parseConsistencySetCookie } from "./consistency-cookie";

const internal = process.env.API_INTERNAL_URL ?? "http://api:3001";

/**
 * Server-side fetch wrapper for calling the NestJS API. Forwards the request's
 * session cookies so the api's SessionGuard sees the same Auth.js JWT.
 *
 * Only attaches `content-type: application/json` when there is actually a body
 * to send. Fastify (the api's HTTP adapter) refuses POST/PUT/PATCH requests
 * whose content-type claims JSON but whose body is empty — this used to break
 * every body-less mutation (e.g. POST /notifications/:id/read).
 *
 * XFF forwarding: we take only the leftmost token of x-forwarded-for. The
 * Caddyfile overrides XFF with the real client IP per hop, so when we see
 * it here it's a single trusted value. If anything ever changes Caddy to
 * stop clobbering, the leftmost-token slice still keeps us from passing
 * along an attacker-supplied chain.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");

  const hdrs = await headers();
  const xffRaw = hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip") ?? "";
  const clientIp = xffRaw.split(",")[0]?.trim() ?? "";

  // The browser's own User-Agent, so the audit log and the session list say what signed in (Node's fetch would say "node").
  const userAgent = hdrs.get("user-agent") ?? "";

  const hasBody = init?.body !== undefined && init?.body !== null && init?.body !== "";

  const res = await fetch(`${internal}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
      ...(userAgent ? { "user-agent": userAgent } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  await relayConsistencyCookie(res);
  return res;
}

/**
 * Hand the API's `church_rv` cookie (see consistency-cookie.ts) on to the browser. Every mutating call the
 * web makes for a person goes through here or `streamToApi`, so no route handler has to remember it. It
 * is set through `cookies()`, which Next merges into whatever response the handler returns. Only a
 * mutating API answer carries the cookie, and those come from route handlers and server actions, where
 * cookies may be written; a read during page rendering never has one, and the catch covers the rest.
 */
async function relayConsistencyCookie(res: Response): Promise<void> {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const c = parseConsistencySetCookie(line);
    if (!c) continue;
    try {
      (await cookies()).set(CONSISTENCY_COOKIE, c.value, { path: "/", maxAge: c.maxAge, httpOnly: true, sameSite: "lax" });
    } catch {
      // not in a place where cookies can be written; the next request is only "within about a second"
    }
  }
}

/**
 * Stream a browser upload (multipart, with its boundary) on to the API without buffering it, and give the
 * API what `apiFetch` does: the person's cookies, their address and browser (the audit log records them;
 * without them an upload was audited as the web container, agent "node") and the consistency cookie back.
 */
export async function streamToApi(req: Request, path: string): Promise<Response> {
  const cookieHeader = req.headers.get("cookie");
  const hdrs: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  const contentLength = req.headers.get("content-length");
  if (contentType) hdrs["content-type"] = contentType;
  if (contentLength) hdrs["content-length"] = contentLength;
  if (cookieHeader) hdrs["cookie"] = cookieHeader;
  const clientIp = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0]?.trim() ?? "";
  if (clientIp) hdrs["x-forwarded-for"] = clientIp;
  const userAgent = req.headers.get("user-agent");
  if (userAgent) hdrs["user-agent"] = userAgent;
  const upstream = await fetch(`${internal}${path}`, {
    method: "POST",
    headers: hdrs,
    body: req.body,
    // @ts-expect-error - undici-specific: required when streaming a request body
    duplex: "half",
  });
  await relayConsistencyCookie(upstream);
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

/**
 * Forward a browser request from a Next route handler to the API path
 * `upstream` (query string carried over), returning the API's status and
 * body unchanged. The API enforces auth and permissions; this only relays.
 */
export async function forwardToApi(req: Request, upstream: string): Promise<Response> {
  const search = new URL(req.url).search;
  const init: RequestInit = { method: req.method };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) init.body = body;
  }
  const res = await apiFetch(`${upstream}${search}`, init);
  // apiFetch has already handed the API's consistency cookie on to the browser.
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
