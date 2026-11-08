import { Settings } from "lucide-react";
import { SIGNAGE_GENERAL_KEYS } from "@lampstand/shared";
import { loadModuleSettings } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";
import { KeySection, ReleasesSection } from "./settings-sections";
import { SIGNAGE_SETTINGS_NAV } from "./nav";

export const dynamic = "force-dynamic";

/** The module's own settings page (never under Admin > Settings): general knobs, the SSH key, agent versions. */
export default async function SignageSettingsPage() {
  const s = await loadModuleSettings(SIGNAGE_GENERAL_KEYS);
  return (
    <ModuleSettingsPage title="Signage settings" icon={Settings} nav={SIGNAGE_SETTINGS_NAV}>
      <SettingsFormSection id="sig-general" title="General" settings={s} category="signage" deniedText="Only a Signage admin can change these." />
      <KeySection />
      <ReleasesSection />
    </ModuleSettingsPage>
  );
}
