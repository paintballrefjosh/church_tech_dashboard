import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.toString();
  const res = await apiFetch(`/api/v1/notes${search ? `?${search}` : ""}`);
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await apiFetch("/api/v1/notes", { method: "POST", body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
