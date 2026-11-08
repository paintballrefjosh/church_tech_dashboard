import type { ComponentType, ReactNode } from "react";
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

export function ModuleSettingsPage({ title, icon, nav, intro, children }: { title: string; icon: IconType; nav?: NavItem[]; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <PageTitle icon={icon}>{title}</PageTitle>
      {nav && nav.length > 1 ? <SettingsNav label="Settings pages" items={nav} /> : null}
      {intro ? <p className="text-sm text-slate-600 dark:text-slate-300">{intro}</p> : null}
      {children}
    </div>
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
