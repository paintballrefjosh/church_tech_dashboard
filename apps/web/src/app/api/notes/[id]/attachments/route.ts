import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

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
  const apiUrl =
    (process.env.API_INTERNAL_URL ?? "http://api:3001") +
    `/api/v1/notes/${encodeURIComponent(id)}/attachments`;
  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  const contentLength = req.headers.get("content-length");
  if (contentType) headers["content-type"] = contentType;
  if (contentLength) headers["content-length"] = contentLength;
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;

  const upstream = await fetch(apiUrl, {
    method: "POST",
    headers,
    // The Web Streams body is fine for fetch; Node fetch accepts ReadableStream.
    body: req.body,
    // @ts-expect-error — undici-specific: required when streaming a request body
    duplex: "half",
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
