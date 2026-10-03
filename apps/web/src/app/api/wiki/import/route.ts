import { NextResponse, type NextRequest } from "next/server";

// Streams the multipart body straight through to the API, same pattern as
// the attachment-upload proxy (apps/web/src/app/api/wiki/[id]/attachments/route.ts)
// — import metadata (title/visibility/parentId/parentFolderId) rides the
// query string rather than multipart fields, so it's forwarded as-is.
export async function POST(req: NextRequest) {
  const apiUrl =
    (process.env.API_INTERNAL_URL ?? "http://api:3001") +
    `/api/v1/wiki/import${req.nextUrl.search}`;
  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  const contentLength = req.headers.get("content-length");
  if (contentType) headers["content-type"] = contentType;
  if (contentLength) headers["content-length"] = contentLength;
  const cookie = req.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  const upstream = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: req.body,
    // @ts-expect-error — undici-specific: required when streaming a request body
    duplex: "half",
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
