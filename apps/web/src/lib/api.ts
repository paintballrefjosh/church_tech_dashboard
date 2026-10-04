import { cookies, headers } from "next/headers";

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

  const hasBody = init?.body !== undefined && init?.body !== null && init?.body !== "";

  return fetch(`${internal}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
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
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
