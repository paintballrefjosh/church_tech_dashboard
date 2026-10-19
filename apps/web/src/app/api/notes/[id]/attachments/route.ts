import { NextResponse, type NextRequest } from "next/server";
import { apiFetch, streamToApi } from "@/lib/api";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await apiFetch(`/api/v1/notes/${encodeURIComponent(id)}/attachments`);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

/**
 * Streams the inbound multipart body to the api. We *don't* call apiFetch
 * here because that helper sets a JSON content-type and buffers the body —
 * for uploads we need to pass the original Content-Type (with boundary) and
 * stream the bytes through.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return streamToApi(req, `/api/v1/notes/${encodeURIComponent(id)}/attachments`);
}
