import { redirect } from "next/navigation";
import { Activity, Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";
import { MonitoringTabs } from "../../section-tabs";

export const dynamic = "force-dynamic";

/** The UniFi controller connection (docs/module-settings.md), with its Test connection button. */
export default async function UnifiSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("unifi"));
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <ModuleSettingsPage inLayout back={{ href: "/monitoring/network", label: "Network (UniFi)" }} title="UniFi settings" icon={Settings}>
          <SettingsFormSection
            id="unifi-conn"
            title="Controller"
            description="The UniFi controller's address and API key, and what to read and alert on. Use Test connection after saving."
            settings={s}
            category="unifi"
            deniedText="Only a Monitoring admin can change these."
          />
        </ModuleSettingsPage>
      </main>
    </>
  );
}
