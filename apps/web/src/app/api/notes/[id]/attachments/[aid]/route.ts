import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await ctx.params;
  const upstream = await apiFetch(
    `/api/v1/notes/${encodeURIComponent(id)}/attachments/${encodeURIComponent(aid)}`,
  );
  if (!upstream.ok || !upstream.body) {
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }
  // Stream the bytes back to the browser; preserve the api's content headers
  // so images render inline and downloads keep their original filenames.
  const headers = new Headers();
  for (const k of ["content-type", "content-disposition", "cache-control", "content-length"]) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new NextResponse(upstream.body, { status: 200, headers });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; aid: string }> },
) {
  const { id, aid } = await ctx.params;
  const res = await apiFetch(
    `/api/v1/notes/${encodeURIComponent(id)}/attachments/${encodeURIComponent(aid)}`,
    { method: "DELETE" },
  );
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
