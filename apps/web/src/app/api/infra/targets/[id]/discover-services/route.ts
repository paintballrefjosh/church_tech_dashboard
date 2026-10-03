import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await apiFetch(`/api/v1/infra/targets/${encodeURIComponent(id)}/discover-services`, {
    method: "POST",
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
