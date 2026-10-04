import { forwardToApi } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return forwardToApi(req, `/api/v1/admin/api-tokens/${encodeURIComponent(id)}`);
}
