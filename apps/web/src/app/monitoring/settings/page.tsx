import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, Settings } from "lucide-react";
import { ALERT_KEYS } from "@lampstand/shared";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection, SettingsSection } from "@/components/module-settings";
import { MonitoringTabs } from "../section-tabs";

export const dynamic = "force-dynamic";

const ALERT_SETTING_KEYS: string[] = Object.values(ALERT_KEYS);
/** Maintenance mode has its own switch on the tab row (it needs an end time and a confirmation), so the generic form leaves it out. */
const MAINTENANCE_KEYS = new Set(["monitoring.maintenance_mode", "monitoring.maintenance_until"]);

/**
 * Monitoring's own settings (docs/module-settings.md): how often things are polled, how long history is kept, and how alerts
 * behave. The UniFi controller, DNS, IPAM and UPS each have their own settings page next to the thing they configure.
 */
export default async function MonitoringSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const keys = settingKeysOf("monitoring").filter((k) => !MAINTENANCE_KEYS.has(k));
  const [collect, alerts] = await Promise.all([
    loadModuleSettings(keys.filter((k) => !ALERT_SETTING_KEYS.includes(k))),
    loadModuleSettings(ALERT_SETTING_KEYS),
  ]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <ModuleSettingsPage inLayout title="Monitoring settings" icon={Settings}>
          <SettingsFormSection
            id="mon-collect"
            title="Checks and history"
            description="How often hosts are polled, how many are polled at once, and how long finished history is kept."
            settings={collect}
            category="monitoring"
            deniedText="Only a Monitoring admin can change these."
          />
          <SettingsFormSection
            id="mon-alerts"
            title="Alerts"
            description="When a flapping service is held back, when an unacknowledged problem is raised again, who is told next, and what the status page says. Where alerts are sent is set on the Alerts tab."
            settings={alerts}
            category="monitoring"
            deniedText="Only a Monitoring admin can change these."
          />
          <SettingsSection id="mon-maint" title="Maintenance mode" description="Pausing alerts for a while is the switch at the right of the tab row above. It can end by itself at a time you choose.">
            <p className="text-sm text-slate-600 dark:text-slate-300">Incidents are still recorded while it is on; only the notifications are paused.</p>
          </SettingsSection>
          <SettingsSection id="mon-other" title="Other monitoring settings" description="These sit next to the thing they configure.">
            <ul className="text-sm">
              {[
                ["/monitoring/network/settings", "UniFi controller"],
                ["/monitoring/ups/settings", "UPS defaults"],
                ["/dns/settings", "DNS server and sync"],
                ["/ipam/settings", "IPAM scanning"],
              ].map(([href, label]) => (
                <li key={href}>
                  <Link href={href!} className="inline-flex min-h-8 items-center text-brand-600 hover:underline dark:text-brand-400">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </SettingsSection>
        </ModuleSettingsPage>
      </main>
    </>
  );
}
