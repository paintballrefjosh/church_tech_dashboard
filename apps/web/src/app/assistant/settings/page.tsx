import { redirect } from "next/navigation";
import { Bot } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection, SettingsSection } from "@/components/module-settings";
import { SettingsForm } from "@/components/settings-form";
import { AssistantPanel } from "./assistant-panel";

export const dynamic = "force-dynamic";

/**
 * The assistant's own settings (docs/module-settings.md D3). Site admins only for now: it sends wiki, ticket and live-system
 * content to an outside provider, so the setup checklist, the privacy notice and the provider's details stay with them.
 */
export default async function AssistantSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("assistant"));
  return (
    <ModuleSettingsPage chrome back={{ href: "/assistant", label: "the assistant" }} title="Assistant settings" icon={Bot}>
      {s ? (
        <>
          <AssistantPanel />
          <SettingsSection id="as-settings" title="Provider, limits and history" description="The model that answers, what it may cost, and how long conversations are kept.">
            <SettingsForm known={s.known} current={s.current} category="assistant" />
          </SettingsSection>
        </>
      ) : (
        <SettingsFormSection id="as-denied" title="Provider, limits and history" settings={null} category="assistant" deniedText="Only a site admin can change these, because the assistant sends the site's content to an outside provider." />
      )}
    </ModuleSettingsPage>
  );
}
