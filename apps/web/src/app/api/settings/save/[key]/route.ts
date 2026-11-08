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
    // Surface the API's human-readable message (e.g. the toggle-prerequisite
    // rejection) rather than the raw NestJS error envelope.
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
      else if (Array.isArray(parsed.message)) message = parsed.message.join("; ");
    } catch {
      /* not JSON — fall back to the raw text */
    }
    return NextResponse.json(
      { error: message || `Save failed (${res.status})` },
      { status: res.status },
    );
  }
  return NextResponse.json({ ok: true });
}
