import { Settings } from "lucide-react";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** How the IPAM scanner sweeps subnets (docs/module-settings.md). The IPAM layout above supplies the top bar and title. */
export default async function IpamSettingsPage() {
  const s = await loadModuleSettings(settingKeysOf("ipam"));
  return (
    <ModuleSettingsPage inLayout back={{ href: "/ipam", label: "IPAM" }} title="IPAM settings" icon={Settings}>
      <SettingsFormSection
        id="ipam-scan"
        title="Scanning"
        description="Whether subnets are swept in the background, how often, and which name lookups and ports to use."
        settings={s}
        category="ipam"
        deniedText="Only a Monitoring admin can change these."
      />
    </ModuleSettingsPage>
  );
}
