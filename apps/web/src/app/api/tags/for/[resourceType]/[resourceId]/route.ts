import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ resourceType: string; resourceId: string }> },
) {
  const { resourceType, resourceId } = await ctx.params;
  const res = await apiFetch(
    `/api/v1/tags/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`,
  );
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ resourceType: string; resourceId: string }> },
) {
  const { resourceType, resourceId } = await ctx.params;
  const body = await req.text();
  const res = await apiFetch(
    `/api/v1/tags/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`,
    { method: "POST", body },
  );
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
