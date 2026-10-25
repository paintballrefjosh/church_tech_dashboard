import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/** Proxy for /api/renewals[/...] to /api/v1/renewals[/...]; the API checks the permission on every route. */
async function forward(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await ctx.params;
  const search = req.nextUrl.searchParams.toString();
  const rest = path.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const init: RequestInit = { method: req.method };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) init.body = body;
  }
  const res = await apiFetch(`/api/v1/renewals${rest}${search ? `?${search}` : ""}`, init);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
