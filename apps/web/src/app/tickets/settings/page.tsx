import Link from "next/link";
import { redirect } from "next/navigation";
import { Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { loadModuleSettings, settingKeysOf } from "@/lib/load-module-settings";
import { ModuleSettingsPage, SettingsFormSection, SettingsSection } from "@/components/module-settings";
import { SettingsForm } from "@/components/settings-form";
import { HelpdeskEmailPanel, type InboundStatus } from "./helpdesk-email-panel";
import { TICKETS_SETTINGS_NAV } from "./nav";

export const dynamic = "force-dynamic";

/**
 * The Help Desk's own settings (docs/module-settings.md): how long a ticket may wait for a first answer and for a
 * resolution, and the mailbox that turns email into tickets. A Tickets admin edits all of it; outgoing mail stays on the
 * site-wide SMTP settings, which only a site admin changes.
 */
export default async function TicketsSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const [sla, mailbox] = await Promise.all([
    loadModuleSettings(settingKeysOf("tickets")),
    loadModuleSettings(settingKeysOf("helpdesk")),
  ]);
  const status = mailbox ? await apiJson<InboundStatus>("/api/v1/tickets/inbound/status").catch(() => null) : null;
  return (
    <ModuleSettingsPage chrome back={{ href: "/tickets", label: "tickets" }} title="Help Desk settings" icon={Settings} nav={TICKETS_SETTINGS_NAV}>
      <SettingsFormSection
        id="tk-sla"
        title="Response and resolution targets"
        description="How many minutes a ticket of each priority may take to get a first answer and to be resolved. 0 turns that clock off. The support team is told when a ticket has used up part of its target, and again when it is missed."
        settings={sla}
        category="tickets"
        deniedText="Only a Tickets admin can change these."
      />
      <SettingsSection
        id="tk-email"
        title="Tickets from email"
        description={
          <>
            A mailbox this site reads so that an email to the help address opens a ticket, and a reply to a ticket email adds a comment. The
            mailbox lives on your mail server; this is the account the dashboard signs in with. Mail the dashboard sends (ticket updates, alerts) uses
            the site&apos;s mail settings, not this mailbox.
          </>
        }
      >
        {mailbox ? (
          <>
            <HelpdeskEmailPanel initial={status} />
            <div className="mt-4">
              <SettingsForm known={mailbox.known} current={mailbox.current} category="helpdesk" />
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">Only a Tickets admin can change these.</p>
        )}
      </SettingsSection>
      <SettingsSection id="tk-more" title="Saved replies" description="Answers staff give again and again, filled in from a ticket's details.">
        <Link href="/tickets/canned-replies" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
          Open saved replies
        </Link>
      </SettingsSection>
    </ModuleSettingsPage>
  );
}
