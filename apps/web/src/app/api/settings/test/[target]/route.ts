import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/**
 * "Test connection" proxy, shared by Admin settings and every module's own settings page. The settings UI POSTs the relevant subset of
 * its form values to /api/settings/test/<target>; this maps the target to the
 * concrete API endpoint that runs the probe (the API authorises each one). Keeping the mapping here means
 * the front-end never needs to know the internal route shape.
 */
const ROUTES: Record<string, string> = {
  propresenter: "/api/v1/propresenter/test",
  smtp: "/api/v1/mailer/test",
  google: "/api/v1/auth/google/test",
  printers: "/api/v1/printers/test",
  monitoring: "/api/v1/unifi/test",
  dns: "/api/v1/dns/test",
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ target: string }> }) {
  const { target } = await ctx.params;
  const upstream = ROUTES[target];
  if (!upstream) {
    return NextResponse.json({ ok: false, message: `unknown test target: ${target}` }, { status: 400 });
  }
  const body = await req.text();
  const res = await apiFetch(upstream, { method: "POST", body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
