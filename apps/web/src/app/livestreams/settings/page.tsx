import { redirect } from "next/navigation";
import { Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** Livestreams' own settings (docs/module-settings.md): the optional platform keys, and how many streams are sampled at once. */
export default async function LivestreamsSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("livestreams"));
  return (
    <ModuleSettingsPage back={{ href: "/livestreams", label: "Livestreams" }} title="Livestreams settings" icon={Settings}>
      <SettingsFormSection
        id="ls-platforms"
        title="Platform keys and limits"
        description="Every platform key is optional. They add what a platform's own API can say (viewer counts, whether a private Facebook stream is live, your Resi encoders). The limit is how many streams one node samples for sound and picture at once."
        settings={s}
        category="livestreams"
        deniedText="Only a Livestreams admin can change these."
      />
    </ModuleSettingsPage>
  );
}
