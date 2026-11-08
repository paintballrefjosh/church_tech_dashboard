import { ShieldCheck } from "lucide-react";
import { SIGNAGE_SECURITY_KEYS } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { SettingsForm } from "../../admin/settings/settings-form";
import { SettingsSubnav } from "../settings/settings-sections";
import { loadSignageSettings } from "../settings/load-settings";

export const dynamic = "force-dynamic";

/**
 * How the Pis are locked down after setup (docs/signage.md section 3). A change here applies to each Pi the next time
 * its settings are applied; the Devices page marks Pis whose settings differ.
 */
export default async function SignageSecurityPage() {
  const s = await loadSignageSettings(SIGNAGE_SECURITY_KEYS);
  return (
    <div className="space-y-6">
      <PageTitle icon={ShieldCheck}>Security settings</PageTitle>
      <SettingsSubnav />
      <p className="text-sm text-slate-600 dark:text-slate-300">
        How each Pi is locked down once it is set up. A change reaches a Pi when its settings are applied again (Devices: &quot;Apply settings again&quot;); until then the Pi is marked as differing. Every change is checked by a second login before it is kept, so a
        setting that would lock the dashboard out is undone by the Pi itself after two minutes.
      </p>
      {s ? <SettingsForm known={s.known} current={s.current} category="signage" /> : <p className="text-sm text-slate-600 dark:text-slate-300">Only a Signage admin can change these.</p>}
    </div>
  );
}
