export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ status: "ok", service: "web", ts: new Date().toISOString() });
}
