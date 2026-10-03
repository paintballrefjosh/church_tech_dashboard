import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

const ALLOWED = new Set(["next", "previous", "clear"]);

export async function POST(_req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!ALLOWED.has(action)) {
    return NextResponse.json({ message: "unknown action" }, { status: 400 });
  }
  const res = await apiFetch(`/api/v1/propresenter/${action}`, { method: "POST" });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
