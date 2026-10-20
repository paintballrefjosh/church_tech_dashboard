import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

/** /api/switch-models → /api/v1/switch-models (list, create). The api enforces auth and permission. */
async function relay(res: Response) {
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET() {
  return relay(await apiFetch("/api/v1/switch-models"));
}

export async function POST(req: NextRequest) {
  return relay(await apiFetch("/api/v1/switch-models", { method: "POST", body: await req.text() }));
}
