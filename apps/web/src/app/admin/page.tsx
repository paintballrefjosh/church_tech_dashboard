import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";

export default async function AdminHome() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          <li className="rounded-md border border-slate-200 p-4 dark:border-slate-800">
            <Link href="/admin/settings" className="text-base font-medium text-brand-600 hover:underline">
              Settings
            </Link>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Configure Google OAuth, SMTP, site name. Stored in the database — no file edits required.
            </p>
          </li>
        </ul>
      </main>
    </>
  );
}
