import Link from "next/link";
import { BookOpen } from "lucide-react";
import { KNOWN_SETTINGS, PERMISSIONS, SIGNAGE_GENERAL_KEYS, SIGNAGE_SECURITY_KEYS } from "@lampstand/shared";
import { viewerPermissions } from "@/lib/load-module-settings";
import { Bullets, Callout, GuidePage, GuideSection, GuideSub, SettingsReference, Steps, Troubleshooting, type GuideEntry } from "@/components/guide";

export const dynamic = "force-dynamic";

const pick = (keys: readonly string[]) => keys.map((k) => KNOWN_SETTINGS.find((s) => s.key === k)).filter((s): s is (typeof KNOWN_SETTINGS)[number] => !!s);

const lk = "text-brand-600 underline dark:text-brand-400";

/**
 * The Signage guide: what the module is, how to bring a Pi into it, how to use it day to day, what to do when something is
 * wrong, and what each setting means. Lives inside the module (a tab of its own) so everything stays in one place; the design
 * record is docs/signage.md and this page must stay true to it. The settings tables are read from the catalogue.
 * Parts only a Signage administrator can use are left out for everyone else.
 */
export default async function SignageGuidePage() {
  const perms = await viewerPermissions();
  const admin = perms.has(PERMISSIONS.SIGNAGE_ADMIN);
  const write = perms.has(PERMISSIONS.SIGNAGE_WRITE_ANY);

  const contents: GuideEntry[] = [
    { id: "overview", title: "What Signage does" },
    ...(admin ? [{ id: "quick-start", title: "Quick start" }, { id: "provisioning", title: "Adopting a Raspberry Pi" }] : []),
    { id: "day-to-day", title: "Day to day" },
    ...(admin ? [{ id: "device-buttons", title: "The device page buttons" }] : []),
    { id: "troubleshooting", title: "When something is wrong" },
    ...(admin ? [{ id: "settings", title: "Settings reference" }] : []),
  ];

  return (
    <GuidePage
      title="Signage guide"
      icon={BookOpen}
      intro="How the TV screens work, how to bring a Raspberry Pi into the system, and what to do when a screen misbehaves."
      contents={contents}
    >
      <Callout>
        <p>
          <strong>Not yet proven on real equipment.</strong> Signage was built and tested against simulated Pis. The steps here follow what the dashboard does, but the first real Pis may behave differently. If something in this guide does not match what you see, trust what you see and tell the
          person who looks after the dashboard.
        </p>
      </Callout>

      <GuideSection id="overview" title="What Signage does">
        <p>
          Each TV is driven by a small Raspberry Pi behind it. You choose what a <strong>screen</strong> shows here, in the dashboard; the Pi plays it. The Pi keeps what it was last sent, so a screen carries on playing (and keeps its TV power times) if the dashboard or the Wi-Fi is down.
        </p>
        <Bullets>
          <li>
            <strong>Media</strong> are the pictures and videos you upload. They are converted once so every Pi can play them.
          </li>
          <li>
            <strong>Playlists</strong> put media in order, with how long each item shows.
          </li>
          <li>
            <strong>Screens</strong> are the places a TV hangs (Foyer, Cafe). A screen is what you plan for; the Pi behind it can be swapped without changing the plan.
          </li>
          <li>
            <strong>Schedule</strong> says which playlist a screen, a group of screens or every screen shows, and when: one time (a wedding, a conference) or repeating every week or on some weeks of the month (the first and last Saturday). Each entry has a priority from Lowest to Highest. On the month calendar, double-click a day to add to it, or right-click a day (or an event) for a small menu.
          </li>
          <li>
            <strong>Power</strong> turns the TV on and off at set times, and the Pi keeps those times itself.
          </li>
        </Bullets>
        <p>
          Where two entries meet on a screen, the one with the higher priority shows; two entries at the same priority are not allowed to overlap on a screen (saving says which one is in the way, so you can give one of them a different priority). When nothing is scheduled a screen shows its fallback playlist, and with none, the church logo. The next 14 days are sent to the Pi ahead of time.
        </p>
        <p>
          Your permission decides what you see: reading Signage shows the screens and content, editing content needs the moderator level, and only an administrator sees the Devices and Settings tabs.
        </p>
      </GuideSection>

      {admin ? (
        <GuideSection id="quick-start" title="Quick start" adminOnly>
          <Steps>
            <li>
              <strong>Flash a card.</strong> Use Raspberry Pi Imager to put Raspberry Pi OS Lite (64-bit) on the SD card. In Imager&apos;s settings give every Pi the <em>same</em> user name and password, turn on SSH, and add the Wi-Fi if the Pi will not be on a cable. Put the card in, plug in the TV and power.
            </li>
            <li>
              <strong>Tell the dashboard that login.</strong> Under <Link href="/signage/security" className={lk}>Settings, Security settings</Link> save the setup user name and password. It is used only to set Pis up, and you can type a different one for a single Pi.
            </li>
            <li>
              <strong>Find the Pi.</strong> On <Link href="/signage/devices" className={lk}>Devices</Link> a new Pi appears in the found list once the dashboard has scanned the network. If several Pis are new, use <em>Show a code</em> on each: it puts a number on that Pi&apos;s TV so you know which is which.
            </li>
            <li>
              <strong>Adopt it.</strong> Press <em>Adopt</em>, give it a name and choose the screen it drives (or make a new one). Watch the log; it takes a few minutes, and the Pi may restart itself at the end.
            </li>
            <li>
              <strong>Give the screen something to show.</strong> Upload media, put it in a playlist, then add the playlist to the screen&apos;s schedule (or make it the fallback).
            </li>
          </Steps>
        </GuideSection>
      ) : null}

      {admin ? (
        <GuideSection id="provisioning" title="Adopting a Raspberry Pi" adminOnly>
          <GuideSub title="What a Pi needs">
            <Bullets>
              <li>A Raspberry Pi 3B+, 4 or 5, on the latest Raspberry Pi OS (64-bit, the Debian 13 &quot;trixie&quot; release). The Lite image is best; the full desktop image works and is switched to console boot by setup. Anything else is refused with the reason.</li>
              <li>It must be reachable from the dashboard on port 22 (SSH) and have the correct time. Give each Pi a fixed address (a DHCP reservation) so the dashboard always finds it.</li>
            </Bullets>
          </GuideSub>
          <GuideSub title="How the dashboard finds and manages Pis">
            <p>
              Finding a Pi never signs in: the dashboard only looks for SSH on the networks it is told about and recognises a Pi by its address and name. Passwords are used only when you press <em>Adopt</em>. After setup, the dashboard manages the Pi with its own key, not a password, and the Pi never calls the dashboard.
            </p>
          </GuideSub>
          <GuideSub title="What setup does">
            <p>Adopting checks the Pi, installs the player and the agent (the program that plays content and talks to the TV), puts the dashboard&apos;s key on it, and applies the Security settings. Every step is skipped if it is already done, so running it again is safe.</p>
          </GuideSub>
          <GuideSub title="Taking a Pi out again">
            <p>
              <em>Forget</em> on a device page returns the Pi to a normal Raspberry Pi first (the original login works again, the dashboard&apos;s key and lock-down are removed) and then drops it from the list. It restarts once or twice. If the dashboard cannot reach the Pi it will not forget it, because the Pi would stay locked to the dashboard&apos;s key; the page offers to forget it without a reset.
            </p>
          </GuideSub>
          <Callout kind="warning">
            <p>If you re-flash a Pi&apos;s card, the Pi shows a different SSH host key and the dashboard refuses to sign in until you press <em>Trust the new host key</em> on its device page. That check is what stops another machine taking over the address.</p>
          </Callout>
        </GuideSection>
      ) : null}

      <GuideSection id="day-to-day" title="Day to day">
        <Bullets>
          <li>
            <strong>
              <Link href="/signage" className={lk}>
                Screens
              </Link>
            </strong>
            : every screen, whether its Pi is online and what it is playing now.
          </li>
          <li>
            <strong>
              <Link href="/signage/media" className={lk}>
                Media
              </Link>
            </strong>
            {write ? ": upload pictures and videos. A file shows as converting for a short while before it can be used." : ": the pictures and videos available."}
          </li>
          <li>
            <strong>
              <Link href="/signage/playlists" className={lk}>
                Playlists
              </Link>
            </strong>
            : the order and length of each item.
          </li>
          <li>
            <strong>
              <Link href="/signage/schedules" className={lk}>
                Schedule
              </Link>
            </strong>
            : a month calendar of what shows when (switch to List for every entry). Use <em>Notice on every screen now</em> for something urgent. Changes are sent to the Pis on their own; <em>Send content now</em> on a device page sends them at once.
          </li>
          <li>
            <strong>
              <Link href="/signage/power" className={lk}>
                Power
              </Link>
            </strong>
            : when each TV turns on and off.
          </li>
        </Bullets>
        {!write ? <p>You can look at all of this; changing it needs the moderator level on Signage.</p> : null}
      </GuideSection>

      {admin ? (
        <GuideSection id="device-buttons" title="The device page buttons" adminOnly>
          <p>
            Each device page (<Link href="/signage/devices" className={lk}>Devices</Link>, then a Pi) has a row of actions. Hover over the three that are easy to confuse to see a short reminder; here is the fuller version.
          </p>
          <Troubleshooting
            label="What the three maintenance buttons do"
            heads={["Button", "What it does", "When to use it"]}
            rows={[
              {
                symptom: <>Apply settings again</>,
                cause: <>Makes the Pi match the current Signage settings: login account, SSH rules, firewall, read-only root, Wi-Fi, time server and OS update window. Brings the agent up to date if it is behind. Does not change what the screen plays; restarts the Pi only if a boot setting needs it.</>,
                fix: <>Use after changing a setting, or when the page says &quot;Settings: not yet applied&quot;. It checks with a second login and undoes itself within 2 minutes if the dashboard could not get back in. Safe to repeat.</>,
              },
              {
                symptom: <>Update the agent</>,
                cause: <>Copies the agent version this dashboard carries to the Pi (checked against its hash), switches to it and restarts the agent, even if the version already matches.</>,
                fix: <>Use when the Agent line on the page is behind. If the new agent is not healthy within 2 minutes the Pi goes back to the old one. Settings and content are untouched.</>,
              },
              {
                symptom: <>Adopt again</>,
                cause: <>Runs the whole setup from the start: check, install or repair the player and agent, key, Security settings. You can change the name, the screen and the login for this Pi.</>,
                fix: <>Use for a Pi that failed setup, was re-flashed, or has stopped answering. It works even when the Pi is not currently working, and needs no password if the dashboard&apos;s key still opens it.</>,
              },
            ]}
          />
        </GuideSection>
      ) : null}

      <GuideSection id="troubleshooting" title="When something is wrong">
        <p>A Pi that needs attention shows a badge on its row, and the Devices tab shows how many. Start with the badge.</p>
        <Troubleshooting
          label="Signage troubleshooting"
          rows={[
            {
              symptom: <>A screen is black</>,
              cause: <>The TV is off or on another input, the Pi has no power, or the player has stopped.</>,
              fix: (
                <>
                  Check the TV and the Pi&apos;s power light. {admin ? "On the device page try Ask the TV, TV on, then Restart the player." : "Ask a Signage administrator to restart the player from the device page."}
                </>
              ),
            },
            {
              symptom: <>Offline</>,
              cause: <>The dashboard has not heard from the Pi for about 5 minutes while its screen should be on. A TV switched off by its power times is not a problem.</>,
              fix: <>Check power, the network cable or Wi-Fi, and that the Pi&apos;s address has not changed. The Pi keeps playing what it has meanwhile.</>,
            },
            {
              symptom: <>Content behind, or files missing</>,
              cause: <>The newest plan or some media has not reached the Pi, often because it was offline or a file is still converting.</>,
              fix: <>{admin ? "Press Send content now on the device page." : "Wait a few minutes; if it stays, ask a Signage administrator to send the content now."} A file still converting cannot be sent yet.</>,
            },
            {
              symptom: <>Settings not applied</>,
              cause: <>The Pi&apos;s lock-down or system settings differ from the Signage settings, usually because a setting was changed.</>,
              fix: <>{admin ? "Press Apply settings again on the device page." : "A Signage administrator can apply them from the device page."}</>,
            },
            {
              symptom: <>Host key changed</>,
              cause: <>The Pi at that address shows a different SSH identity: its card was re-flashed or replaced, or another machine took the address.</>,
              fix: <>{admin ? "If you know the Pi was re-flashed, press Trust the new host key on its device page, then Adopt again." : "Ask a Signage administrator; do not ignore it if nobody re-flashed the Pi."}</>,
            },
            {
              symptom: <>Adoption failed</>,
              cause: <>The log shows the step that stopped: wrong setup login, no sudo, an unsupported OS, or not enough space.</>,
              fix: <>{admin ? "Read the run log on the device page, fix the cause, then Adopt again." : "A Signage administrator can read the log on the device page."}</>,
            },
            {
              symptom: <>TV does not respond to on or off</>,
              cause: <>The TV is not answering the Pi over the network (Roku) or over HDMI-CEC.</>,
              fix: <>{admin ? "Use Ask the TV and Diagnostics on the device page. Check that CEC or network control is enabled in the TV's own settings." : "Check the TV's own settings for HDMI-CEC or network control; a Signage administrator can run diagnostics."}</>,
            },
            {
              symptom: <>Under-voltage, low disk, clock not in sync, or a hot Pi</>,
              cause: <>A weak power supply, a nearly full card, no time source, or poor airflow.</>,
              fix: <>{admin ? "Run Diagnostics on the device page. " : ""}Replace the power supply with the official one, or move the Pi somewhere cooler. Until the clock is in sync the Pi plays the fallback and skips TV power times.</>,
            },
          ]}
        />
      </GuideSection>

      {admin ? (
        <GuideSection id="settings" title="Settings reference" adminOnly>
          <p>
            Every setting is changed on the module&apos;s own pages: <Link href="/signage/security" className={lk}>Security settings</Link> for how a Pi is adopted and locked down, and <Link href="/signage/settings" className={lk}>Settings</Link> for the rest. A changed setting reaches a Pi the next time its settings are applied; until then the Pi is marked as differing. This list is read from the settings themselves, so it matches what the pages show.
          </p>
          <Callout>
            <p>The lock-down choices start relaxed while the module is being tried on real Pis, so that you can still log in to a Pi to find out what is wrong. Turn them on once the Pis behave; the Security overview lists each relaxed choice.</p>
          </Callout>
          <GuideSub title="Security settings">
            <SettingsReference settings={pick(SIGNAGE_SECURITY_KEYS)} label="Signage security settings" />
          </GuideSub>
          <GuideSub title="General settings">
            <SettingsReference settings={pick(SIGNAGE_GENERAL_KEYS)} label="Signage general settings" />
          </GuideSub>
        </GuideSection>
      ) : null}
    </GuidePage>
  );
}
