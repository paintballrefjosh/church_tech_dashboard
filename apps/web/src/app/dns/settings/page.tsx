import { Settings } from "lucide-react";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** The Technitium DNS primary and the IPAM-to-DNS sync (docs/module-settings.md). The DNS layout above supplies the top bar and title. */
export default async function DnsSettingsPage() {
  const s = await loadModuleSettings(settingKeysOf("dns"));
  return (
    <ModuleSettingsPage inLayout back={{ href: "/dns", label: "DNS" }} title="DNS settings" icon={Settings}>
      <SettingsFormSection
        id="dns-server"
        title="Server and sync"
        description="The Technitium cluster's primary server and its API token, the alert when it cannot be reached, and whether hosts found by IPAM get DNS records."
        settings={s}
        category="dns"
        deniedText="Only a Monitoring admin can change these."
      />
    </ModuleSettingsPage>
  );
}
