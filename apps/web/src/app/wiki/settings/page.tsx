import Link from "next/link";
import { redirect } from "next/navigation";
import { Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection, SettingsSection } from "@/components/module-settings";

export const dynamic = "force-dynamic";

/** The Wiki's own settings (docs/module-settings.md): how long a page may go without a look before its owner is asked. */
export default async function WikiSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const s = await loadModuleSettings(settingKeysOf("wiki"));
  return (
    <ModuleSettingsPage chrome back={{ href: "/wiki", label: "the wiki" }} title="Wiki settings" icon={Settings}>
      <SettingsFormSection
        id="wk-review"
        title="Keeping pages up to date"
        description="Every page is checked against this time. A page that has gone this long without an edit or a confirmation that it is still correct is marked as needing a review, and its owner is told. A page can set its own time, or opt out."
        settings={s}
        category="wiki"
        deniedText="Only a Wiki admin can change these."
      />
      <SettingsSection id="wk-more" title="Page templates" description="Outlines people start a new page from.">
        <Link href="/wiki/templates" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
          Open page templates
        </Link>
      </SettingsSection>
    </ModuleSettingsPage>
  );
}
