import Link from "next/link";
import { redirect } from "next/navigation";
import { Settings as SettingsIcon, ArrowRight } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { KNOWN_SETTINGS } from "@church/shared";
import { SETTINGS_CATEGORIES, type CategoryMeta } from "./categories";

export const dynamic = "force-dynamic";

interface MePayload {
  permissions?: string[];
}

const SECTION_TITLES: Record<CategoryMeta["section"], string> = {
  core: "Site administration",
  module: "Module settings",
};

export default async function AdminSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const perms = new Set(me?.permissions ?? []);

  // Count settings per category so the hub cards can show "3 settings" etc.
  // — gives operators a hint about depth without clicking through.
  const counts = new Map<string, number>();
  for (const s of KNOWN_SETTINGS) {
    counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  }
  // Only render category cards that (a) actually have settings registered and
  // (b) the current user is allowed to manage. A module admin therefore sees
  // just their module's category; a site admin sees everything.
  const visible = SETTINGS_CATEGORIES.filter(
    (c) => (counts.get(c.slug) ?? 0) > 0 && perms.has(c.permission),
  );
  const sections: CategoryMeta["section"][] = ["core", "module"];

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={SettingsIcon}>Settings</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          All values are stored in the database. Pick a section to edit; changes take effect
          immediately for any feature that reads them.
        </p>

        {visible.length === 0 ? (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            You don't have permission to manage any settings.
          </p>
        ) : (
          sections.map((section) => {
            const cards = visible.filter((c) => c.section === section);
            if (cards.length === 0) return null;
            return (
              <section key={section} className="mt-8 first:mt-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {SECTION_TITLES[section]}
                </h2>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                  {cards.map((c) => {
                    const n = counts.get(c.slug) ?? 0;
                    return (
                      <li key={c.slug}>
                        <Link
                          href={`/admin/settings/${c.slug}`}
                          className="flex h-full items-start gap-3 rounded-md border border-slate-300 p-4 transition hover:border-brand-500 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
                        >
                          <c.Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-base font-medium">{c.label}</span>
                              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                {n} setting{n === 1 ? "" : "s"}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{c.description}</p>
                          </div>
                          <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </main>
    </>
  );
}
