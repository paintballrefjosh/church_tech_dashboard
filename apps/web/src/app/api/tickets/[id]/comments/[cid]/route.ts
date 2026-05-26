import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> },
) {
  const { id, cid } = await ctx.params;
  const res = await apiFetch(
    `/api/v1/tickets/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}`,
    { method: "DELETE" },
  );
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
