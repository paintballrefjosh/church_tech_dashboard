import { redirect } from "next/navigation";
import { ShieldCheck, KeyRound } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { apiJson } from "@/lib/api";
import { TotpPanel } from "./totp-panel";

export default async function SecurityPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  // Server-side initial state so the panel renders without a flash.
  let enabled = false;
  try {
    const status = await apiJson<{ enabled: boolean }>("/api/v1/auth/totp/status");
    enabled = status.enabled;
  } catch {
    // fall through; the panel will reflect 'unknown' but allow enroll
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={ShieldCheck}>Security</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Signed in as {session.user.email}.
        </p>

        <section className="mt-8 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <KeyRound className="h-5 w-5 text-brand-600" aria-hidden />
            Two-factor authentication (TOTP)
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Use an authenticator app (1Password, Authy, Google Authenticator, etc.)
            to generate a 6-digit code at sign-in. Required for administrators.
          </p>
          <div className="mt-4">
            <TotpPanel initialEnabled={enabled} />
          </div>
        </section>
      </main>
    </>
  );
}
