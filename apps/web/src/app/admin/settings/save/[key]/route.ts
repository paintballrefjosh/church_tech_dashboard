import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const body = await req.text();
  const res = await apiFetch(`/api/v1/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: text || `Save failed (${res.status})` }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}
