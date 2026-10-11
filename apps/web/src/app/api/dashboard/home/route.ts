import type { NextRequest } from "next/server";
import { forwardToApi } from "@/lib/api";

/** GET /api/dashboard/home?include=week,meters: the home snapshot. The API checks access per section. */
export async function GET(req: NextRequest) {
  return forwardToApi(req, "/api/v1/dashboard/home");
}
