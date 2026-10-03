import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.toString();
  const res = await apiFetch(`/api/v1/audit${search ? `?${search}` : ""}`);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
