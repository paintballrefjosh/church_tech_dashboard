import { redirect } from "next/navigation";
import { signIn, auth } from "@/lib/auth";

const localEnabled = process.env.AUTH_DISABLE_LOCAL !== "true";
const googleEnabled = !!process.env.GOOGLE_OAUTH_CLIENT_ID;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string; totp?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const params = await searchParams;
  const error = params.error;
  const needsTotp = params.totp === "1";

  async function signinLocal(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const totp = String(formData.get("totp") ?? "");
    try {
      await signIn("credentials", {
        email,
        password,
        totp: totp || undefined,
        redirectTo: "/",
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("TOTP_REQUIRED")) {
        redirect("/signin?totp=1");
      }
      redirect("/signin?error=Invalid+credentials");
    }
  }

  async function signinGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Church Dashboard</p>

        {error ? (
          <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        {googleEnabled ? (
          <form action={signinGoogle} className="mt-5">
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Continue with Google
            </button>
          </form>
        ) : null}

        {googleEnabled && localEnabled ? (
          <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            <span>or</span>
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          </div>
        ) : null}

        {localEnabled ? (
          <form action={signinLocal} className="mt-2 space-y-3">
            <label className="block">
              <span className="text-sm text-slate-700 dark:text-slate-300">Email</span>
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700 dark:text-slate-300">Password</span>
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            {needsTotp ? (
              <label className="block">
                <span className="text-sm text-slate-700 dark:text-slate-300">Two-factor code</span>
                <input
                  name="totp"
                  inputMode="numeric"
                  pattern="\d{6}"
                  required
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-950"
                />
              </label>
            ) : null}
            <button
              type="submit"
              className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Sign in
            </button>
          </form>
        ) : null}

        {!googleEnabled && !localEnabled ? (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            No sign-in methods are configured. Set GOOGLE_OAUTH_CLIENT_ID or AUTH_DISABLE_LOCAL=false in .env.
          </p>
        ) : null}
      </div>
    </main>
  );
}
