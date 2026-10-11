"use client";

import Link from "next/link";
import { BookOpen, CalendarDays, FileText, ListChecks, Ticket } from "lucide-react";
import { summarize } from "@church/shared";
import { NaveArches, type NaveGlow } from "@/components/nave-arches";
import type { LookProps } from "../../look-props";
import { useSectionHidden } from "../../home-look-context";
import { useHomeSnapshot } from "../../use-home-snapshot";
import { Countdown } from "../../parts/countdown";
import { LookPickerButton } from "../../picker/look-picker";
import { RelativeTime } from "../../parts/relative-time";
import { karla, marcellus } from "./fonts";
import {
  countdownTarget,
  dateLine,
  greeting,
  serviceStarts,
  whenLine,
  whenShort,
} from "./nave-format";
import { NeedsWindow, SystemsWindow, TeamWindow, windowWanted } from "./windows";
import s from "./nave.module.css";

const DARK_GLOW: NaveGlow = {
  shape: "circle",
  rx: 150,
  stops: [
    { offset: 0, color: "#fff3d6", opacity: 1 },
    { offset: 0.25, color: "#f6c76e", opacity: 0.55 },
    { offset: 1, color: "#f6c76e", opacity: 0 },
  ],
};
const LIGHT_GLOW: NaveGlow = {
  shape: "circle",
  rx: 150,
  blend: "multiply",
  stops: [
    { offset: 0, color: "#ffd98a", opacity: 0.9 },
    { offset: 0.3, color: "#f6c76e", opacity: 0.4 },
    { offset: 1, color: "#f6c76e", opacity: 0 },
  ],
};

const COMMON = {
  viewBox: { width: 600, height: 660 },
  cx: 300,
  vpY: 330,
  count: 10,
  halfWidth: [330, 14] as const,
  apexY: [40, 324] as const,
  sillY: [760, 340] as const,
  strokeWidth: [2.2, 1] as const,
  delay: [0.1, 0.6] as const,
};

/** Both schemes are drawn; the CSS shows the one that matches `.dark` (no flash, no hydration mismatch). */
function Arches() {
  return (
    <>
      <NaveArches
        {...COMMON}
        className={`${s.archSvg} ${s.archLight}`}
        idPrefix="home-nave-l"
        colorStops={[
          { at: 0, rgb: [0x9a, 0xa2, 0xe6] },
          { at: 0.6, rgb: [0x3a, 0x44, 0xa8] },
          { at: 1, rgb: [0xd9, 0x91, 0x10] },
        ]}
        opacity={[0.38, 0.95]}
        glow={LIGHT_GLOW}
      />
      <NaveArches
        {...COMMON}
        className={`${s.archSvg} ${s.archDark}`}
        idPrefix="home-nave-d"
        colorStops={[
          { at: 0, rgb: [0x6b, 0x74, 0xd6] },
          { at: 1, rgb: [0xff, 0xe4, 0xb0] },
        ]}
        opacity={[0.14, 0.95]}
        glow={DARK_GLOW}
      />
    </>
  );
}

export default function NaveLook(props: LookProps) {
  const { snapshot, refresh } = useHomeSnapshot(props.snapshot, []);
  const { me, kiosk } = props;
  const hidden = useSectionHidden();
  const tz = snapshot.timezone;
  const now = new Date(snapshot.generatedAt);
  const svc = snapshot.service.state === "ok" ? snapshot.service.data : null;
  const starts = svc ? serviceStarts(svc) : [];
  const target = countdownTarget(starts, now);
  const when = svc ? whenLine(starts, now, tz) : null;
  const team = svc?.team ?? null;
  const teamTotal = team ? team.confirmed + team.waiting + team.declined : 0;
  const summary = summarize(snapshot);
  const isPlan = svc?.source === "planning_center";

  const showSystems = !hidden("systems") && windowWanted(snapshot.systems);
  const showTeam = !hidden("team") && team !== null && team.positions.length > 0;
  const showNeeds = !hidden("foryou") && windowWanted(snapshot.needs);
  const windowCount = [showSystems, showTeam, showNeeds].filter(Boolean).length;

  const activity = !hidden("week") && snapshot.activity.state === "ok" ? snapshot.activity.data.slice(0, 5) : null;
  const wiki = !hidden("wiki") && snapshot.wiki.state === "ok" ? snapshot.wiki.data.recent.slice(0, 5) : null;
  const creates: { href: string; label: string; icon: typeof Ticket }[] = [];
  if (!hidden("create") && me.access.tickets) creates.push({ href: "/tickets/new", label: "New ticket", icon: Ticket });
  if (!hidden("create") && me.access.wiki) creates.push({ href: "/wiki/new", label: "New wiki page", icon: BookOpen });
  if (!hidden("create") && me.access.notes) creates.push({ href: "/notes", label: "Write a note", icon: FileText });
  const aisleCount = [activity !== null, wiki !== null, creates.length > 0].filter(Boolean).length;

  return (
    <div data-look="nave" className={`${s.root} ${marcellus.variable} ${karla.variable}`}>
      <section className={s.hero} aria-labelledby="nave-hero-title">
        <div className={s.arches} aria-hidden>
          <Arches />
        </div>
        <div className={s.wrap}>
          <div className={s.heroBody}>
            {svc ? (
              <>
                <p className={s.eve}>
                  {greeting(snapshot)}. It&apos;s {dateLine(now, tz)}.
                </p>
                <h1 id="nave-hero-title" className={s.heroTitle}>
                  {svc.title}
                </h1>
                {when ? <p className={s.times}>{when}</p> : null}
                {svc.seriesTitle ? <p className={s.series}>{svc.seriesTitle}</p> : null}
                {target || teamTotal > 0 ? (
                  <div className={`${s.count} ${s.num}`}>
                    {target ? (
                      <Countdown to={target} serverNow={snapshot.generatedAt}>
                        {(left) =>
                          left.done ? (
                            <div>
                              <b>Now</b>
                              <span>under way</span>
                            </div>
                          ) : (
                            <>
                              {left.days > 0 ? (
                                <div>
                                  <b>{left.days}</b>
                                  <span>{left.days === 1 ? "day" : "days"}</span>
                                </div>
                              ) : null}
                              <div>
                                <b>{left.hours}</b>
                                <span>{left.hours === 1 ? "hour" : "hours"}</span>
                              </div>
                              <div>
                                <b>{String(left.minutes).padStart(2, "0")}</b>
                                <span>{left.minutes === 1 ? "minute" : "minutes"}</span>
                              </div>
                            </>
                          )
                        }
                      </Countdown>
                    ) : null}
                    {team && teamTotal > 0 ? (
                      <div>
                        <b>
                          {team.confirmed}/{teamTotal}
                        </b>
                        <span>team confirmed</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className={s.heroActions}>
                  <Link href={svc.href} className={`${s.btn} ${s.btnPrimary}`}>
                    <CalendarDays className={s.btnIcon} aria-hidden />
                    {isPlan ? "Open the service plan" : "Open the checklist"}
                  </Link>
                  {me.access.checklists ? (
                    <Link href="/checklists" className={s.btn}>
                      <ListChecks className={s.btnIcon} aria-hidden />
                      Checklists
                    </Link>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <h1 id="nave-hero-title" className={s.heroTitle}>
                  {greeting(snapshot)}
                </h1>
                <p className={s.times}>{dateLine(now, tz)}</p>
                {summary.length > 0 ? (
                  <p className={s.summary}>
                    {summary.map((t, i) =>
                      t.kind === "link" ? (
                        <Link key={i} href={t.href} className={`${s.summaryLink} ${s[`tone_${t.tone}`]}`}>
                          {t.text}
                        </Link>
                      ) : (
                        <span key={i}>{t.text}</span>
                      ),
                    )}
                  </p>
                ) : null}
                {me.access.checklists ? (
                  <div className={s.heroActions}>
                    <Link href="/checklists" className={s.btn}>
                      <ListChecks className={s.btnIcon} aria-hidden />
                      Checklists
                    </Link>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>

      <main className={s.wrap}>
        {windowCount > 0 ? (
          <div className={s.windows} data-count={windowCount}>
            {showSystems ? <SystemsWindow section={snapshot.systems} /> : null}
            {showTeam && team ? <TeamWindow team={team} /> : null}
            {showNeeds ? <NeedsWindow section={snapshot.needs} meId={snapshot.user.id} onChanged={() => void refresh()} /> : null}
          </div>
        ) : null}

        {aisleCount > 0 ? (
          <div className={s.aisle} data-count={aisleCount}>
            {activity ? (
              <section className={s.plain} aria-labelledby="nave-week">
                <h2 id="nave-week" className={s.plainTitle}>
                  This week
                  <Link href="/activity">All activity</Link>
                </h2>
                {activity.length === 0 ? (
                  <p className={s.empty}>Nothing has happened yet.</p>
                ) : (
                  <ul className={`${s.feed} ${s.num}`}>
                    {activity.map((a) => (
                      <li key={a.id}>
                        <time dateTime={a.at}>{whenShort(a.at, now, tz)}</time>
                        <span>
                          {a.actorName ? <b>{a.actorName}</b> : null} {a.href ? <Link href={a.href}>{a.summary}</Link> : a.summary}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
            {wiki ? (
              <section className={s.plain} aria-labelledby="nave-wiki">
                <h2 id="nave-wiki" className={s.plainTitle}>
                  Wiki
                  <Link href="/wiki">Browse</Link>
                </h2>
                {wiki.length === 0 ? (
                  <p className={s.empty}>No pages yet.</p>
                ) : (
                  <ul className={s.wiki}>
                    {wiki.map((w) => (
                      <li key={w.id}>
                        <Link href={w.href}>
                          <span>{w.title}</span>
                          <RelativeTime at={w.updatedAt} serverNow={snapshot.generatedAt} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
            {creates.length > 0 ? (
              <section className={s.plain} aria-labelledby="nave-make">
                <h2 id="nave-make" className={s.plainTitle}>
                  Start something
                </h2>
                <div className={s.make}>
                  {creates.map((c) => (
                    <Link key={c.href} href={c.href}>
                      <c.icon className={s.btnIcon} aria-hidden />
                      {c.label}
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </main>

      <footer className={s.footer}>
        {snapshot.site.tagline.trim() ? <p className={s.tagline}>{snapshot.site.tagline}</p> : null}
        {kiosk ? null : <LookPickerButton className={s.pickerBtn} />}
      </footer>
    </div>
  );
}
