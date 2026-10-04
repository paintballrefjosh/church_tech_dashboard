import { forwardToApi } from "@/lib/api";

export const GET = (req: Request) => forwardToApi(req, "/api/v1/me/api-tokens");
export const POST = (req: Request) => forwardToApi(req, "/api/v1/me/api-tokens");
