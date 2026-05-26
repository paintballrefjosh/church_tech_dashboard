import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { NotesBoard } from "./notes-board";
import type { Note } from "@church/shared";

export const dynamic = "force-dynamic";

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; q?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const params = await searchParams;
  const qs = new URLSearchParams();
  if (params.archived === "true") qs.set("archived", "true");
  if (params.q) qs.set("q", params.q);
  const initial = await apiJson<Note[]>(`/api/v1/notes${qs.toString() ? `?${qs}` : ""}`).catch(
    () => [] as Note[],
  );
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <NotesBoard
          initial={initial}
          initialArchived={params.archived === "true"}
          initialQuery={params.q ?? ""}
        />
      </main>
    </>
  );
}
