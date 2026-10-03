import { redirect } from "next/navigation";
import { Cross, LogIn } from "lucide-react";
import { signIn, auth, getProviderConfig } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { SignInForm } from "./signin-form";
import { ChapelWindow } from "./chapel-window";
import { ThemeToggle } from "@/components/theme-toggle";

interface SiteIdentity {
  name: string;
  tagline: string;
}

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; code?: string; callbackUrl?: string; totp?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const params = await searchParams;
  const accountDeleted =
    params.error === "AccountDeleted" || params.code === "account_deleted";
  const initialError = accountDeleted
    ? "This account has been deleted. Contact an administrator."
    : params.error;
  const needsTotp = params.totp === "1";
  const callbackUrl = params.callbackUrl ?? "/";
  const cfg = await getProviderConfig();
  const identity =
    (await apiJson<SiteIdentity>("/api/v1/site/identity").catch(() => null)) ?? {
      name: "Church Dashboard",
      tagline: "",
    };

  async function signinGoogle() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }
  async function signinMicrosoft() {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
  }

  const anyOAuth = cfg.google.enabled || cfg.microsoft.enabled;
  const oauthButton =
    "group inline-flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:-translate-y-px hover:border-slate-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:focus-visible:ring-offset-slate-950";

  return (
    <main className="relative grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="fixed right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      {/* Atmosphere panel — a receding nave archway toward the light. Hidden on
          small screens, where a compact header stands in instead. */}
      <aside className="relative hidden overflow-hidden bg-[#06061a] lg:block">
        <ChapelWindow />
        {/* Scrim so the wordmark stays legible over the arch lines. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-[#06061a] via-[#06061a]/85 to-transparent"
          aria-hidden
        />
        <div className="absolute inset-0 flex flex-col justify-end p-14">
          <div className="auth-rise" style={{ animationDelay: "0.55s" }}>
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
              <Cross className="h-5 w-5 text-amber-100" aria-hidden />
            </span>
            <h2 className="mt-5 max-w-md bg-gradient-to-br from-white to-indigo-200 bg-clip-text text-4xl font-semibold leading-tight tracking-tight text-transparent xl:text-5xl">
              {identity.name}
            </h2>
            {identity.tagline ? (
              <p className="mt-4 max-w-md text-lg leading-relaxed text-indigo-100/75">
                {identity.tagline}
              </p>
            ) : null}
            <p className="mt-6 text-sm text-indigo-200/50">
              Welcome back. Sign in to pick up where you left off.
            </p>
          </div>
        </div>
      </aside>

      {/* Form panel. */}
      <section className="relative flex items-center justify-center overflow-hidden bg-slate-50 px-4 py-12 dark:bg-slate-950">
        {/* Faint ambient wash so the small-screen view isn't flat (the panel
            above carries the motion on large screens). */}
        <div
          className="pointer-events-none absolute inset-0 lg:hidden"
          aria-hidden
        >
          <div
            className="auth-aurora h-72 w-72 bg-brand-400/20 dark:bg-brand-500/20"
            style={{ top: "-4rem", right: "-3rem" }}
          />
        </div>

        <div className="relative w-full max-w-sm">
          {/* Compact brand header — only when the atmosphere panel is hidden. */}
          <div
            className="auth-rise mb-8 flex flex-col items-center text-center lg:hidden"
            style={{ animationDelay: "0.05s" }}
          >
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 shadow-lg shadow-brand-600/30">
              <Cross className="h-6 w-6 text-white" aria-hidden />
            </span>
            <p className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
              {identity.name}
            </p>
          </div>

          <div
            className="auth-rise rounded-2xl border border-slate-200 bg-white/90 p-7 shadow-xl shadow-slate-900/5 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-black/20"
            style={{ animationDelay: "0.12s" }}
          >
            <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
              <LogIn className="h-5 w-5 text-brand-600 dark:text-brand-400" aria-hidden />
              Sign in
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Use your account to continue.
            </p>

            {initialError ? (
              <p className="mt-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
                {initialError === "CredentialsSignin" ? "Invalid credentials" : initialError}
              </p>
            ) : null}

            {cfg.google.enabled ? (
              <form action={signinGoogle} className="mt-5">
                <button type="submit" className={oauthButton}>
                  <GoogleMark /> Continue with Google
                </button>
              </form>
            ) : null}

            {cfg.microsoft.enabled ? (
              <form action={signinMicrosoft} className="mt-3">
                <button type="submit" className={oauthButton}>
                  <MicrosoftMark /> Continue with Microsoft
                </button>
              </form>
            ) : null}

            {anyOAuth && cfg.local.enabled ? (
              <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                <span>or</span>
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              </div>
            ) : null}

            {cfg.local.enabled ? (
              <SignInForm callbackUrl={callbackUrl} needsTotp={needsTotp} />
            ) : null}

            {!anyOAuth && !cfg.local.enabled ? (
              <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                No sign-in methods are configured. An admin needs to enable local sign-in or
                configure an OAuth provider at{" "}
                <code className="font-mono">/admin/settings</code>.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

// Inline brand marks — small, no extra deps. Drawn from each company's brand
// guidance simplified to flat fills so they read at 16px.

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M21.6 12.227c0-.709-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.996 3.018v2.51h3.232c1.891-1.742 2.982-4.305 2.982-7.351z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.964-.895 6.618-2.422l-3.232-2.51c-.895.6-2.041.955-3.386.955-2.605 0-4.81-1.76-5.596-4.123H3.064v2.59A9.996 9.996 0 0 0 12 22z"
      />
      <path
        fill="#FBBC05"
        d="M6.404 13.9a6.006 6.006 0 0 1 0-3.8V7.51H3.064a9.996 9.996 0 0 0 0 8.98l3.34-2.59z"
      />
      <path
        fill="#EA4335"
        d="M12 5.977c1.468 0 2.786.504 3.823 1.496l2.868-2.868C16.96 2.99 14.695 2 12 2 8.09 2 4.71 4.234 3.064 7.51l3.34 2.59C7.19 7.737 9.395 5.977 12 5.977z"
      />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="2" width="9" height="9" fill="#F25022" />
      <rect x="13" y="2" width="9" height="9" fill="#7FBA00" />
      <rect x="2" y="13" width="9" height="9" fill="#00A4EF" />
      <rect x="13" y="13" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}
