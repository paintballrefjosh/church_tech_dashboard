import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET() {
  const res = await apiFetch("/api/v1/ticket-categories");
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await apiFetch("/api/v1/ticket-categories", { method: "POST", body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
