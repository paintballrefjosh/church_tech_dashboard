import { forwardToApi } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** Issue a token to another user (e.g. a service account). */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return forwardToApi(req, `/api/v1/admin/users/${encodeURIComponent(id)}/api-tokens`);
}
