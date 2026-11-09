import { redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";
import { PLANNING_CENTER_SETTINGS_NAV } from "../nav";

export const dynamic = "force-dynamic";

/** Planning Center's own settings (docs/module-settings.md): the app id and secret, and the service type the dashboard shows. */
export default async function PlanningCenterSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("planning_center"));
  return (
    <ModuleSettingsPage chrome back={{ href: "/planning-center", label: "Planning Center" }} title="Planning Center settings" icon={CalendarDays} nav={PLANNING_CENTER_SETTINGS_NAV}>
      <SettingsFormSection
        id="pc-connection"
        title="Connection"
        description="A Planning Center personal access token (its application id and secret), and the service type whose upcoming plans the dashboard shows by default."
        settings={s}
        category="planning_center"
        deniedText="Only a Planning Center admin can change these."
      />
    </ModuleSettingsPage>
  );
}
