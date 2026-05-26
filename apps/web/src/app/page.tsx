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
            Signed in as <span className="font-mono">{session.user.email}</span>.
          </p>
        </div>
        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/tickets"
            className="rounded-lg border border-slate-200 p-5 transition hover:border-brand-500 hover:shadow-sm dark:border-slate-800 dark:hover:border-brand-500"
          >
            <h2 className="text-base font-semibold">Tickets</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Open a help request, track status, comment, assign. Support staff see everything.
            </p>
          </Link>
          <Link
            href="/notes"
            className="rounded-lg border border-slate-200 p-5 transition hover:border-brand-500 hover:shadow-sm dark:border-slate-800 dark:hover:border-brand-500"
          >
            <h2 className="text-base font-semibold">Notes</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Your personal scratch space, Keep-style. Pin, colour-code, archive.
            </p>
          </Link>
          <Link
            href="/admin"
            className="rounded-lg border border-slate-200 p-5 transition hover:border-brand-500 hover:shadow-sm dark:border-slate-800 dark:hover:border-brand-500"
          >
            <h2 className="text-base font-semibold">Admin</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Settings, users, groups, roles, audit log. Admin role only.
            </p>
          </Link>
        </section>
      </main>
    </>
  );
}
