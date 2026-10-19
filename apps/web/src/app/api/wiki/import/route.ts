import type { NextRequest } from "next/server";
import { streamToApi } from "@/lib/api";

// Streams the multipart body straight through to the API, same pattern as the attachment-upload proxies
// (import metadata (title/visibility/parentId/parentFolderId) rides the query string, so it is forwarded as-is).
export async function POST(req: NextRequest) {
  return streamToApi(req, `/api/v1/wiki/import${req.nextUrl.search}`);
}
