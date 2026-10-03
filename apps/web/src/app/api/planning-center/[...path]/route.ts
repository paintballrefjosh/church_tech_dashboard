import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/**
 * Catch-all proxy for /api/planning-center/* → /api/v1/planning-center/*.
 * A single file keeps us from maintaining a route handler per PC endpoint;
 * the api server enforces auth + permission per-route as usual.
 */
async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const search = req.nextUrl.searchParams.toString();
  const upstream = `/api/v1/planning-center/${path.map(encodeURIComponent).join("/")}${
    search ? `?${search}` : ""
  }`;
  const init: RequestInit = { method: req.method };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }
  const res = await apiFetch(upstream, init);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = forward;
export const POST = forward;
export const DELETE = forward;
