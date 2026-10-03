import { KeyRound } from "lucide-react";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-lg border border-slate-300 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <KeyRound className="h-5 w-5 text-brand-600" aria-hidden />
          Forgot your password?
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Enter your email and we&apos;ll send you a single-use reset link.
        </p>
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
