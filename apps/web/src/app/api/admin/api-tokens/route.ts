import { forwardToApi } from "@/lib/api";

export const GET = (req: Request) => forwardToApi(req, "/api/v1/admin/api-tokens");
