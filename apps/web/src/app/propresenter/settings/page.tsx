import { redirect } from "next/navigation";
import { Presentation } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** ProPresenter's own settings (docs/module-settings.md): where the ProPresenter 7 machine is and its remote password. */
export default async function ProPresenterSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("propresenter"));
  return (
    <ModuleSettingsPage chrome back={{ href: "/propresenter", label: "ProPresenter" }} title="ProPresenter settings" icon={Presentation}>
      <SettingsFormSection
        id="pp-connection"
        title="Connection"
        description="The host and port of the ProPresenter 7 machine's network API (default port 1025), and its remote password if it has one."
        settings={s}
        category="propresenter"
        deniedText="Only a ProPresenter admin can change these."
      />
    </ModuleSettingsPage>
  );
}
