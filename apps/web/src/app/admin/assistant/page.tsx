import Link from "next/link";
import { redirect } from "next/navigation";
import { Bot } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";

export const dynamic = "force-dynamic";

interface Count {
  name: string;
  n: number;
}
interface Usage {
  month: string;
  questions: number;
  cost: number;
  budget: number;
  days: Array<{ day: string; questions: number; inputTokens: number; outputTokens: number; cost: number; errors: number }>;
  answers: {
    total: number;
    outcomes: Count[];
    errors: Count[];
    latencyMs: { p50: number | null; p95: number | null };
    firstTokenMs: { p50: number | null; p95: number | null };
    ratings: { up: number; down: number };
    notFound: number;
    lookups: Count[];
    proposals: Count[];
  };
}

const secs = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)} s`);
const card = "rounded-md border border-slate-300 p-4 dark:border-slate-800";
const h2 = "text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";

function Counts({ title, rows, empty }: { title: string; rows: Count[]; empty: string }) {
  return (
    <section className={card} aria-label={title}>
      <h2 className={h2}>{title}</h2>
      {rows.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.name} className="flex justify-between gap-3">
              <span className="font-mono text-xs">{r.name}</span>
              <span>{r.n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{empty}</p>
      )}
    </section>
  );
}

/**
 * The assistant's usage this month (docs/assistant.md section 12): questions, cost against the budget, outcomes, timings,
 * ratings and what it looked up. Figures only: no question or answer text, and no names (conversations are private).
 */
export default async function AssistantUsagePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const res = await apiFetch("/api/v1/assistant/admin/usage");
  const u = res.ok ? ((await res.json()) as Usage) : null;
  const a = u?.answers;
  const pct = u && u.budget > 0 ? Math.min(100, Math.round((u.cost / u.budget) * 100)) : null;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Bot}>Assistant usage</PageTitle>
        {!u || !a ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {res.status === 403 ? "This page needs the moderator tier of the Assistant module, or site administration." : "The figures could not be read."}
          </p>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {u.month}: {u.questions} question{u.questions === 1 ? "" : "s"}, cost {u.cost.toFixed(2)}
              {u.budget > 0 ? ` of a ${u.budget.toFixed(2)} budget` : " (no budget: the model costs nothing)"}. Settings are under{" "}
              <Link href="/admin/settings/assistant" className="text-brand-600 hover:underline dark:text-brand-400">
                Site settings, Assistant
              </Link>
              . Figures only: no question or answer is shown here.
            </p>
            {pct !== null ? (
              <div>
                <div className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800" role="img" aria-label={`${pct}% of the budget used`}>
                  <div className={`h-full ${pct >= 100 ? "bg-rose-600" : pct >= 80 ? "bg-amber-500" : "bg-emerald-600"}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{pct}% of the budget used. Admins are told at 80% and 100%.</p>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ["Answers", String(a.total)],
                ["Time to answer (median / 95%)", `${secs(a.latencyMs.p50)} / ${secs(a.latencyMs.p95)}`],
                ["First words (median / 95%)", `${secs(a.firstTokenMs.p50)} / ${secs(a.firstTokenMs.p95)}`],
                ["Thumbs up / down", `${a.ratings.up} / ${a.ratings.down}`],
                ["Said it could not find it", String(a.notFound)],
              ].map(([label, value]) => (
                <div key={label} className={card}>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
                  <p className="mt-1 text-lg font-semibold">{value}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <Counts title="Outcomes" rows={a.outcomes} empty="No answers yet." />
              <Counts title="Errors by kind" rows={a.errors} empty="No errors." />
              <Counts title="Most used lookups" rows={a.lookups} empty="No lookups yet." />
              <Counts title="Proposed actions" rows={a.proposals} empty="None proposed." />
            </div>
            <section className={card} aria-labelledby="usage-days">
              <h2 id="usage-days" className={h2}>
                By day
              </h2>
              {u.days.length ? (
                <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Usage by day">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-slate-600 dark:text-slate-300">
                      <tr>
                        <th className="py-1 pr-4 font-medium">Day</th>
                        <th className="py-1 pr-4 text-right font-medium">Questions</th>
                        <th className="py-1 pr-4 text-right font-medium">Tokens in / out</th>
                        <th className="py-1 pr-4 text-right font-medium">Cost</th>
                        <th className="py-1 pr-4 text-right font-medium">Failed</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {u.days.map((d) => (
                        <tr key={d.day}>
                          <td className="py-1 pr-4 font-mono text-xs">{d.day}</td>
                          <td className="py-1 pr-4 text-right">{d.questions}</td>
                          <td className="py-1 pr-4 text-right font-mono text-xs">
                            {d.inputTokens.toLocaleString()} / {d.outputTokens.toLocaleString()}
                          </td>
                          <td className="py-1 pr-4 text-right">{d.cost.toFixed(2)}</td>
                          <td className="py-1 pr-4 text-right">{d.errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No questions this month.</p>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
