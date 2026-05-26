import { cookies, headers } from "next/headers";

const internal = process.env.API_INTERNAL_URL ?? "http://api:3001";

/**
 * Server-side fetch wrapper for calling the NestJS API. Forwards the request's
 * session cookies so the api's SessionGuard sees the same Auth.js JWT.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");

  const hdrs = await headers();
  const forwardedFor = hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip") ?? "";

  return fetch(`${internal}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
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
