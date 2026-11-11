import type { ReactNode } from "react";
import { BookOpen, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { PageTitle } from "@/components/page-title";

/**
 * The building blocks of a module's in-app guide (the first is Signage, `/signage/guide`). A guide is a server-rendered page
 * INSIDE its module, so it inherits the module's layout, tab row and access rule, and ships with the code (every node of a
 * cluster shows the same text, an upgrade corrects it). It is written as JSX, not Markdown files read at run time, so the
 * standalone web build always carries it and links, settings tables and other components can sit in the text.
 *
 * Rules: a guide explains the module to the people who run it, it is not the design record (that stays in `docs/`); a
 * settings reference is rendered FROM the catalogue (`KNOWN_SETTINGS`), never retyped, so it cannot drift; a part that only
 * administrators can use says so in its heading note (`adminOnly`) and is left out for everyone else by the page.
 */
export interface GuideEntry {
  id: string;
  title: string;
}

export function GuidePage({ title, icon = BookOpen, intro, contents, children }: { title: string; icon?: LucideIcon; intro: ReactNode; contents: GuideEntry[]; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <PageTitle icon={icon}>{title}</PageTitle>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">{intro}</p>
      </div>
      <div className="fx-reading-block grid gap-8 p-4 sm:p-6 lg:grid-cols-[14rem_1fr]">
        <nav aria-label={`${title} contents`} className="lg:sticky lg:top-20 lg:self-start">
          <ol className="space-y-1 text-sm">
            {contents.map((c) => (
              <li key={c.id}>
                <a href={`#${c.id}`} className="block rounded px-2 py-1 text-brand-600 hover:underline dark:text-brand-400">
                  {c.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="max-w-3xl space-y-10 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{children}</div>
      </div>
    </div>
  );
}

export function GuideSection({ id, title, adminOnly, children }: { id: string; title: string; adminOnly?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 space-y-3">
      <h2 id={`${id}-h`} className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
        {adminOnly ? <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 align-middle text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">Administrators</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function GuideSub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {children}
    </div>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-2 pl-5 marker:font-semibold marker:text-slate-500 dark:marker:text-slate-400">{children}</ol>;
}

export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

export function Callout({ kind = "note", children }: { kind?: "note" | "warning"; children: ReactNode }) {
  const warn = kind === "warning";
  const Icon = warn ? TriangleAlert : Info;
  return (
    <div
      role="note"
      className={`flex gap-2 rounded-md border p-3 ${
        warn ? "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" : "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** A symptom, what it means, what to do (`heads` renames the columns for other uses). Rendered as a table so it can be scanned; scrolls sideways on a phone. */
export function Troubleshooting({ rows, label, heads = ["What you see", "What it means", "What to do"] }: { rows: Array<{ symptom: ReactNode; cause: ReactNode; fix: ReactNode }>; label: string; heads?: [string, string, string] }) {
  return (
    <div tabIndex={0} role="region" aria-label={label} className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-300">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              {heads[0]}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {heads[1]}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {heads[2]}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{r.symptom}</td>
              <td className="px-3 py-2">{r.cause}</td>
              <td className="px-3 py-2">{r.fix}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A settings reference made from catalogue entries (label, description, default), so it always matches the real settings. */
export function SettingsReference({ settings, label }: { settings: ReadonlyArray<{ key: string; type: string; label: string; description: string; defaultValue: unknown }>; label: string }) {
  const shown = (s: { type: string; defaultValue: unknown }) => {
    if (s.type === "secret") return "not set";
    const v = s.defaultValue;
    if (typeof v === "boolean") return v ? "On" : "Off";
    if (v === "" || v === null || v === undefined) return "blank";
    return String(v);
  };
  return (
    <div tabIndex={0} role="region" aria-label={label} className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-300">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Setting
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              What it does
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Starts as
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {settings.map((s) => (
            <tr key={s.key} className="align-top">
              <th scope="row" className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                {s.label}
              </th>
              <td className="px-3 py-2">{s.description}</td>
              <td className="px-3 py-2 whitespace-nowrap">{shown(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
