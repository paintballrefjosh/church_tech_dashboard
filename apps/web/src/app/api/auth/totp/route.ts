import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function DELETE(req: NextRequest) {
  const body = await req.text();
  const res = await apiFetch("/api/v1/auth/totp", { method: "DELETE", body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
