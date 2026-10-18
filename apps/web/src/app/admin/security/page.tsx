import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, ShieldCheck } from "lucide-react";
import type { PostureCheck, PostureReport, PostureSeverity } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";

export const dynamic = "force-dynamic";

const LOOK: Record<PostureSeverity, { label: string; Icon: typeof Info; badge: string; box: string }> = {
  critical: {
    label: "Fix now",
    Icon: AlertOctagon,
    badge: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
    box: "border-rose-300 dark:border-rose-800",
  },
  warn: {
    label: "Needs attention",
    Icon: AlertTriangle,
    badge: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    box: "border-amber-300 dark:border-amber-800",
  },
  info: {
    label: "For your information",
    Icon: Info,
    badge: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
    box: "border-slate-300 dark:border-slate-700",
  },
  ok: {
    label: "In good shape",
    Icon: CheckCircle2,
    badge: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    box: "border-slate-300 dark:border-slate-700",
  },
};

const ORDER: PostureSeverity[] = ["critical", "warn", "info", "ok"];

function headline(r: PostureReport): string {
  if (r.counts.critical > 0) return `${r.counts.critical} thing${r.counts.critical === 1 ? "" : "s"} to fix now`;
  if (r.counts.warn > 0) return `${r.counts.warn} thing${r.counts.warn === 1 ? "" : "s"} need${r.counts.warn === 1 ? "s" : ""} attention`;
  return "Nothing needs attention";
}

function CheckRow({ c }: { c: PostureCheck }) {
  const look = LOOK[c.severity];
  return (
    <li className={`rounded-md border bg-slate-50 p-4 dark:bg-slate-900 ${look.box}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${look.badge}`}>
          <look.Icon className="h-3.5 w-3.5" aria-hidden /> {look.label}
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-medium">{c.title}</h2>
        {c.fix ? (
          <Link href={c.fix.href} className="shrink-0 text-sm text-brand-600 hover:underline dark:text-brand-400">
            {c.fix.label}
          </Link>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{c.detail}</p>
    </li>
  );
}

export default async function SecurityOverviewPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  let report: PostureReport | null = null;
  let error: string | null = null;
  try {
    report = await apiJson<PostureReport>("/api/v1/admin/security-posture");
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <PageTitle icon={ShieldCheck}>Security overview</PageTitle>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          How this site is set up, checked against a short list of things that matter. It reads settings and counts only:
          nothing here changes anything, and no secret is shown. People sign out their own browsers from their{" "}
          <Link href="/me/security" className="text-brand-600 hover:underline dark:text-brand-400">
            Security page
          </Link>
          ; an administrator can sign someone out from{" "}
          <Link href="/admin/users" className="text-brand-600 hover:underline dark:text-brand-400">
            Users
          </Link>
          .
        </p>

        {error || !report ? (
          <p role="alert" className="mt-6 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
            Could not load the overview. {error?.includes("403") ? "It needs the site administrator tier." : "Try again in a moment."}
          </p>
        ) : (
          <>
            <p className="mt-6 text-lg font-medium" role="status">
              {headline(report)}
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {ORDER.map((s) => `${report.counts[s]} ${LOOK[s].label.toLowerCase()}`).join(" · ")}
            </p>
            <ul className="mt-4 space-y-3">
              {report.checks.map((c) => (
                <CheckRow key={c.id} c={c} />
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
