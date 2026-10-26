import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/**
 * Proxy for /api/service-monitoring[/...] to /api/v1/service-monitoring[/...]; the API checks the permission on every route.
 */
async function forward(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await ctx.params;
  const search = req.nextUrl.searchParams.toString();
  const rest = path.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const init: RequestInit = { method: req.method };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) init.body = body;
  }
  const res = await apiFetch(`/api/v1/service-monitoring${rest}${search ? `?${search}` : ""}`, init);
  const headers: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "application/json" };
  for (const h of ["cache-control", "last-modified", "x-content-type-options"]) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return new NextResponse(await res.arrayBuffer(), { status: res.status, headers });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
