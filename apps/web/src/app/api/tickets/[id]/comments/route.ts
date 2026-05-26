import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await apiFetch(`/api/v1/tickets/${encodeURIComponent(id)}/comments`);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.text();
  const res = await apiFetch(`/api/v1/tickets/${encodeURIComponent(id)}/comments`, {
    method: "POST",
    body,
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
