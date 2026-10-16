import { forwardToApi } from "@/lib/api";

export const POST = (req: Request) => forwardToApi(req, "/api/v1/me/sessions/revoke-all");
