import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Forwarder for the monitoring page's service banner. The upstream gates this
 * on monitors:read:any; we just pass through and surface whatever the api
 * answered with so the same auth check applies.
 */
export async function GET() {
  const res = await apiFetch("/api/v1/health/services");
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
