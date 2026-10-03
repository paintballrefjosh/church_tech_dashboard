import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { PendingClient } from "./pending-client";

export const dynamic = "force-dynamic";

/**
 * Holding page for external OAuth accounts awaiting admin approval. Approval
 * state is read fresh from /me (not the session JWT) so that the moment an
 * admin approves the account this page lets them through, and a not-actually-
 * pending user can never get stuck here. The client child then keeps watching
 * (socket + poll + manual re-check) so an already-open tab advances on its own.
 */
export default async function PendingApprovalPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const me = await apiJson<{ approvalStatus?: string }>("/api/v1/me").catch(() => null);
  if (me?.approvalStatus !== "pending") redirect("/");
  const email = session.user.email ?? "your account";

  return <PendingClient email={email} />;
}
