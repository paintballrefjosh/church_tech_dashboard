import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/** Root /api/users — list (GET) and create (POST). Sub-paths handled by [...path]. */
async function forward(req: NextRequest) {
  const search = req.nextUrl.searchParams.toString();
  const upstream = `/api/v1/users${search ? `?${search}` : ""}`;
  const init: RequestInit = { method: req.method };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }
  const res = await apiFetch(upstream, init);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = forward;
export const POST = forward;
