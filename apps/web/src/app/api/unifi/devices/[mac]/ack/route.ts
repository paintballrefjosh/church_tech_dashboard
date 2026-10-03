import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";

/**
 * Proxy for acknowledging / clearing a UniFi device-offline ack.
 * POST   /api/unifi/devices/:mac/ack  → ack an offline device
 * DELETE /api/unifi/devices/:mac/ack  → clear the ack
 * The api server enforces the monitoring write permission.
 */
async function forward(method: "POST" | "DELETE", mac: string): Promise<NextResponse> {
  const res = await apiFetch(`/api/v1/unifi/devices/${encodeURIComponent(mac)}/ack`, { method });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(_req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  return forward("POST", mac);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  return forward("DELETE", mac);
}
