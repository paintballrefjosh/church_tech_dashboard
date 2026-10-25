import { forwardToApi } from "@/lib/api";

/** PUT /api/unifi/devices/:mac/switch-view: which device profile draws this device. The API enforces the monitoring write tier. */
export async function PUT(req: Request, ctx: { params: Promise<{ mac: string }> }) {
  const { mac } = await ctx.params;
  return forwardToApi(req, `/api/v1/unifi/devices/${encodeURIComponent(mac)}/switch-view`);
}
