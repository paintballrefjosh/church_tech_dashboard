import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

async function proxy(method: "PATCH" | "DELETE", id: string, body?: string) {
  const res = await apiFetch(`/api/v1/wiki/folders/${encodeURIComponent(id)}`, { method, body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxy("PATCH", id, await req.text());
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxy("DELETE", id);
}
