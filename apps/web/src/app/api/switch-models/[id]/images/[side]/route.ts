import { NextResponse, type NextRequest } from "next/server";
import { apiFetch, streamToApi } from "@/lib/api";

type Ctx = { params: Promise<{ id: string; side: string }> };

const path = (id: string, side: string) => `/api/v1/switch-models/${encodeURIComponent(id)}/images/${encodeURIComponent(side)}`;

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, side } = await ctx.params;
  const upstream = await apiFetch(path(id, side));
  if (!upstream.ok || !upstream.body) {
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }
  const headers = new Headers();
  for (const k of ["content-type", "content-disposition", "cache-control", "content-length", "x-content-type-options"]) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new NextResponse(upstream.body, { status: 200, headers });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, side } = await ctx.params;
  return streamToApi(req, path(id, side));
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id, side } = await ctx.params;
  const res = await apiFetch(path(id, side), { method: "DELETE" });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
