import Link from "next/link";
import { redirect } from "next/navigation";
import { User, ShieldCheck, Bell, CalendarDays, KeySquare } from "lucide-react";
import { NOTIFICATION_KINDS, type NotificationKind } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { ProfileForm } from "./profile-form";
import { PasswordForm } from "./password-form";
import { DisplayForm } from "./display-form";
import { NotificationPrefsForm } from "./notification-prefs-form";
import { PcLinkForm } from "./pc-link-form";

interface Me {
  id: string;
  email: string;
  name: string | null;
  groups: string[];
  permissions: string[];
  totpEnabled: boolean;
  pageWidth?: "fluid" | "narrow" | "standard" | "wide" | "custom";
  pageWidthPx?: number | null;
  mutedNotificationKinds?: string[];
}

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  let me: Me | null = null;
  try {
    me = await apiJson<Me>("/api/v1/me");
  } catch {
    // /me almost never fails for a signed-in user; if it does the page below
    // will just render with the session's bare info.
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={User}>Profile</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Signed in as {session.user.email}.
          {me && me.groups.length
            ? ` ${me.groups.length === 1 ? "Group" : "Groups"}: ${me.groups.join(", ")}.`
            : ""}
        </p>

        <section className="mt-8 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="text-lg font-medium">Profile</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Your display name and sign-in email.
          </p>
          <div className="mt-4">
            <ProfileForm
              initialName={me?.name ?? ""}
              initialEmail={me?.email ?? session.user.email ?? ""}
            />
          </div>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="text-lg font-medium">Display</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Choose how page content fills the screen. Applies on every device.
          </p>
          <div className="mt-4">
            <DisplayForm
              initial={
                me?.pageWidth && ["fluid", "narrow", "wide", "custom"].includes(me.pageWidth)
                  ? me.pageWidth
                  : "standard"
              }
              initialPx={typeof me?.pageWidthPx === "number" ? me.pageWidthPx : null}
            />
          </div>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="text-lg font-medium">Password</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Pick a new password. The new password takes effect immediately.
          </p>
          <div className="mt-4">
            <PasswordForm />
          </div>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <Bell className="h-5 w-5 text-brand-600" aria-hidden />
            Notifications
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Choose which categories you&apos;re notified about. Enabled categories
            always show in-app (bell + realtime); tick Email to also get an email
            for that category. Turn a category off to silence it entirely.
          </p>
          <div className="mt-4">
            <NotificationPrefsForm kinds={NOTIFICATION_KINDS as readonly NotificationKind[]} />
          </div>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <CalendarDays className="h-5 w-5 text-brand-600" aria-hidden />
            Planning Center
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Link your local account to a Planning Center person so service
            assignments highlight you across the dashboard.
          </p>
          <div className="mt-4">
            <PcLinkForm userEmail={me?.email ?? session.user.email ?? ""} />
          </div>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <ShieldCheck className="h-5 w-5 text-brand-600" aria-hidden />
            Security
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {me?.totpEnabled
              ? "Two-factor authentication is enabled."
              : "Two-factor authentication is not enrolled."}
          </p>
          <Link
            href="/me/security"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Manage two-factor
          </Link>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <KeySquare className="h-5 w-5 text-brand-600" aria-hidden />
            API tokens
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Let a script or an AI agent use the dashboard&apos;s API as you, read-only or limited
            to certain modules if you like.
          </p>
          <Link
            href="/me/api-tokens"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Manage API tokens
          </Link>
        </section>
      </main>
    </>
  );
}
