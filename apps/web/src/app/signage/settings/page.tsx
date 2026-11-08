import { Settings } from "lucide-react";
import { SIGNAGE_GENERAL_KEYS } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { SettingsForm } from "../../admin/settings/settings-form";
import { KeySection, ReleasesSection, SettingsSubnav } from "./settings-sections";
import { loadSignageSettings } from "./load-settings";

export const dynamic = "force-dynamic";

/** The module's own settings page (never under Admin > Settings): general knobs, the SSH key, agent versions. */
export default async function SignageSettingsPage() {
  const s = await loadSignageSettings(SIGNAGE_GENERAL_KEYS);
  return (
    <div className="space-y-6">
      <PageTitle icon={Settings}>Signage settings</PageTitle>
      <SettingsSubnav />
      {s ? (
        <section aria-labelledby="sig-general" className="space-y-2 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <h2 id="sig-general" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            General
          </h2>
          <SettingsForm known={s.known} current={s.current} category="signage" />
        </section>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">Only a Signage admin can change these.</p>
      )}
      <KeySection />
      <ReleasesSection />
    </div>
  );
}
