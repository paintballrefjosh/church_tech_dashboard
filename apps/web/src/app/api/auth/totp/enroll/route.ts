import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";

export async function POST() {
  const res = await apiFetch("/api/v1/auth/totp/enroll", { method: "POST" });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
