import { Settings } from "lucide-react";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** UPS defaults (docs/module-settings.md). The UPS layout above supplies the top bar, title and tabs. */
export default async function UpsSettingsPage() {
  const s = await loadModuleSettings(settingKeysOf("ups"));
  return (
    <ModuleSettingsPage inLayout back={{ href: "/monitoring/ups", label: "UPS" }} title="UPS settings" icon={Settings}>
      <SettingsFormSection
        id="ups-defaults"
        title="Defaults for UPS devices"
        description="Used for a UPS that has no SNMP details of its own, and how often every UPS is read."
        settings={s}
        category="ups"
        deniedText="Only a Monitoring admin can change these."
      />
    </ModuleSettingsPage>
  );
}
