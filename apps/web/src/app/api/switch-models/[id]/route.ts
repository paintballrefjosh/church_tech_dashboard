import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

async function relay(res: Response) {
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return relay(await apiFetch(`/api/v1/switch-models/${encodeURIComponent(id)}`, { method: "PATCH", body: await req.text() }));
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return relay(await apiFetch(`/api/v1/switch-models/${encodeURIComponent(id)}`, { method: "DELETE" }));
}
