import { forwardToApi } from "@/lib/api";

export async function GET(req: Request) {
  return forwardToApi(req, "/api/v1/dashboard/prefs");
}

export async function PUT(req: Request) {
  return forwardToApi(req, "/api/v1/dashboard/prefs");
}
