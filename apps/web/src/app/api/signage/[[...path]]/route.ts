import { NextResponse, type NextRequest } from "next/server";
import { apiFetch, streamToApi } from "@/lib/api";

/**
 * Proxy for /api/signage[/...] to /api/v1/signage[/...]; the API checks the permission on every route. Bytes are passed
 * through as they are, because thumbnails, media files and screenshots answer with pictures and video. Media and agent
 * release uploads do NOT come this way: Next's middleware keeps only the first 10 MB of a request body, so the pages post
 * them to /api/v1/signage/... directly (like backup uploads). Multipart is still streamed for anything small.
 */
async function forward(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await ctx.params;
  const search = req.nextUrl.searchParams.toString();
  const rest = path.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const target = `/api/v1/signage${rest}${search ? `?${search}` : ""}`;
  if (req.method === "POST" && (req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    return streamToApi(req, target);
  }
  const init: RequestInit = { method: req.method };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.text();
    if (body) init.body = body;
  }
  const range = req.headers.get("range");
  if (range) init.headers = { range };
  const res = await apiFetch(target, init);
  const headers: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "application/json" };
  for (const h of ["cache-control", "last-modified", "x-content-type-options", "content-disposition", "content-range", "accept-ranges", "etag"]) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return new NextResponse(res.body, { status: res.status, headers });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
