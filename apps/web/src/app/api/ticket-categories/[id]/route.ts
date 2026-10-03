import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.text();
  const res = await apiFetch(`/api/v1/ticket-categories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await apiFetch(`/api/v1/ticket-categories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
