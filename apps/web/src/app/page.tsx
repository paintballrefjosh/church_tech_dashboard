import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="rounded-lg border border-slate-200 p-6 dark:border-slate-800">
          <h1 className="text-2xl font-semibold">Welcome back</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            You are signed in as <span className="font-mono">{session.user.email}</span>.
          </p>
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            This is the Phase 0 dashboard shell. Tiles (calendar, tickets, notes, etc.) land in Phase 1.
            See <Link href="/admin" className="text-brand-600 underline">admin</Link> if you are signed in as an administrator.
          </p>
        </div>
      </main>
    </>
  );
}
