import { ShieldCheck } from "lucide-react";
import { SIGNAGE_SECURITY_KEYS } from "@lampstand/shared";
import { loadModuleSettings } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection } from "@/components/module-settings";
import { SIGNAGE_SETTINGS_NAV } from "../settings/nav";

export const dynamic = "force-dynamic";

/**
 * How the Pis are locked down after setup (docs/signage.md section 3). A change here applies to each Pi the next time
 * its settings are applied; the Devices page marks Pis whose settings differ.
 */
export default async function SignageSecurityPage() {
  const s = await loadModuleSettings(SIGNAGE_SECURITY_KEYS);
  return (
    <ModuleSettingsPage title="Security settings" icon={ShieldCheck} nav={SIGNAGE_SETTINGS_NAV}>
      <SettingsFormSection
        id="sig-lockdown"
        title="Pi lock-down"
        description={
          <>
            How each Pi is locked down once it is set up. A change reaches a Pi when its settings are applied again (Devices: &quot;Apply settings again&quot;); until then the Pi is marked as differing. Every change is checked by a second login before it is kept, so a
            setting that would lock the dashboard out is undone by the Pi itself after two minutes.
          </>
        }
        settings={s}
        category="signage"
        deniedText="Only a Signage admin can change these."
      />
    </ModuleSettingsPage>
  );
}
