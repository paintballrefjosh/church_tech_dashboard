import { redirect } from "next/navigation";
import { Printer } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** The Printers module's own settings (docs/module-settings.md): the default SNMP login and how often printers are polled. */
export default async function PrintersSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("printers"));
  return (
    <ModuleSettingsPage chrome back={{ href: "/printers", label: "Printers" }} title="Printers settings" icon={Printer}>
      <SettingsFormSection
        id="printers-defaults"
        title="Polling and SNMP defaults"
        description="Used for any printer that does not set its own SNMP version or community, and for how often and how patiently every printer is polled."
        settings={s}
        category="printers"
        deniedText="Only a Printers admin can change these."
      />
    </ModuleSettingsPage>
  );
}
