import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/**
 * Admin "Test connection" proxy. The settings UI POSTs the relevant subset of
 * its form values to /api/admin/test/<category>; this maps the slug to the
 * concrete API endpoint that runs the probe. Keeping the mapping here means
 * the front-end never needs to know the internal route shape.
 */
const ROUTES: Record<string, string> = {
  propresenter: "/api/v1/propresenter/test",
  smtp: "/api/v1/mailer/test",
  google: "/api/v1/auth/google/test",
  printers: "/api/v1/printers/test",
  monitoring: "/api/v1/unifi/test",
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ category: string }> }) {
  const { category } = await ctx.params;
  const upstream = ROUTES[category];
  if (!upstream) {
    return NextResponse.json({ ok: false, message: `unknown test category: ${category}` }, { status: 400 });
  }
  const body = await req.text();
  const res = await apiFetch(upstream, { method: "POST", body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
