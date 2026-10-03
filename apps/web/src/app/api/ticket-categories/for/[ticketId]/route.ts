import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await ctx.params;
  const res = await apiFetch(
    `/api/v1/ticket-categories/for/${encodeURIComponent(ticketId)}`,
  );
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await ctx.params;
  const body = await req.text();
  const res = await apiFetch(
    `/api/v1/ticket-categories/for/${encodeURIComponent(ticketId)}`,
    { method: "PUT", body },
  );
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
