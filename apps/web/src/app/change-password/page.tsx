import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { auth } from "@/lib/auth";
import { ChangePasswordForm } from "./change-password-form";

export default async function ChangePasswordPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const forced = (session.user as { mustChangePassword?: boolean }).mustChangePassword === true;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-lg border border-slate-300 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <KeyRound className="h-5 w-5 text-brand-600" aria-hidden />
          {forced ? "Set a new password" : "Change password"}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {forced
            ? "You're using the default password. Pick a new one to continue."
            : "Pick a new password for your account."}
        </p>
        <ChangePasswordForm />
      </div>
    </main>
  );
}
