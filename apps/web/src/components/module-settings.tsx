import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { SettingsForm } from "@/components/settings-form";
import { SettingsNav, type NavItem } from "@/components/settings-nav";
import type { loadModuleSettings } from "@/lib/load-module-settings";

/**
 * The pieces every module's own settings page is built from (docs/module-settings.md; Signage was the first). A page is
 * `ModuleSettingsPage`, optionally with a `SettingsNav` when the module has more than one settings page, and one or more
 * `SettingsSection`s. `SettingsFormSection` is a section holding the generic settings form for a set of keys.
 *
 * Server-renderable on purpose (a page hands it a lucide icon, which cannot cross into a client component); only the
 * nav, which reads the address, is a client component (`settings-nav.tsx`).
 */

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export function ModuleSettingsPage({
  title,
  icon,
  nav,
  intro,
  back,
  chrome = false,
  inLayout = false,
  children,
}: {
  title: string;
  icon: IconType;
  /** Links between this module's settings pages; drawn only when there is more than one. */
  nav?: NavItem[];
  intro?: ReactNode;
  /** A link back to the module's main page. */
  back?: { href: string; label: string };
  /** True when the module's layout draws no top bar and `<main>` of its own (Printers, ProPresenter, Planning Center); false inside Signage/Livestreams-style layouts. */
  chrome?: boolean;
  /** True when the page sits under a layout that already has the module's own big title and tabs (Monitoring, DNS, IPAM): the title is then a section heading. */
  inLayout?: boolean;
  children: ReactNode;
}) {
  const body = (
    <div className="space-y-6">
      {back ? (
        <Link href={back.href} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to {back.label}
        </Link>
      ) : null}
      {inLayout ? <SectionTitle icon={icon}>{title}</SectionTitle> : <PageTitle icon={icon}>{title}</PageTitle>}
      {nav && nav.length > 1 ? <SettingsNav label="Settings pages" items={nav} /> : null}
      {intro ? <p className="text-sm text-slate-600 dark:text-slate-300">{intro}</p> : null}
      {children}
    </div>
  );
  if (!chrome) return body;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">{body}</main>
    </>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: IconType; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-xl font-semibold">
      <Icon aria-hidden className="h-5 w-5 text-brand-600 dark:text-brand-400" />
      <span>{children}</span>
    </h2>
  );
}

/** A titled box on a settings page. `id` ties the heading to the section for screen readers. */
export function SettingsSection({ id, title, icon: Icon, description, children }: { id: string; title: string; icon?: IconType; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <h2 id={id} className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
        {title}
      </h2>
      {description ? <p className="text-sm text-slate-600 dark:text-slate-300">{description}</p> : null}
      {children}
    </section>
  );
}

/**
 * The generic form for `settings` (the result of `loadModuleSettings`), or a plain line when the viewer may not change
 * them. `category` is the settings category the keys belong to (it picks the "Test connection" buttons).
 */
export function SettingsFormSection({
  id,
  title,
  description,
  settings,
  category,
  deniedText,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  settings: Awaited<ReturnType<typeof loadModuleSettings>>;
  category: string;
  /** Said when `settings` is null, e.g. "Only a Signage admin can change these." */
  deniedText: string;
}) {
  return (
    <SettingsSection id={id} title={title} description={description}>
      {settings ? <SettingsForm known={settings.known} current={settings.current} category={category} /> : <p className="text-sm text-slate-600 dark:text-slate-300">{deniedText}</p>}
    </SettingsSection>
  );
}
