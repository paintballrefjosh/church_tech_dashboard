import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await ctx.params;
  const res = await apiFetch(`/api/v1/monitors/incidents/${encodeURIComponent(incidentId)}/ack`, { method: "POST", body: "{}" });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
