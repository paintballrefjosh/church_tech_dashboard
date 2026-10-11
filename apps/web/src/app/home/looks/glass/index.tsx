"use client";

import Link from "next/link";
import { Albert_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { BookOpen, CalendarDays, Ticket, StickyNote } from "lucide-react";
import {
  calendarDaysBetween,
  formatTimeInZone,
  formatWeekdayInZone,
  summarize,
  type HomeInclude,
  type HomeSnapshot,
  type NextService,
  type Section,
  type SummaryTone,
} from "@church/shared";
import type { LookProps } from "../../look-props";
import { useHomeSnapshot } from "../../use-home-snapshot";
import { Countdown } from "../../parts/countdown";
import { NeedActionButton } from "../../parts/need-action";
import { RelativeTime } from "../../parts/relative-time";
import { LookPickerButton } from "../../picker/look-picker";
import { GlassWindow } from "./window";
import styles from "./glass.module.css";

const font = Albert_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--glass-font", display: "swap" });

const INCLUDES: readonly HomeInclude[] = ["availability"];
const TONE_CLASS: Record<SummaryTone, string> = { ok: styles.tone_ok!, warn: styles.tone_warn!, bad: styles.tone_bad! };

const DAY_PART_GREETING = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" } as const;

function whenLine(s: NextService, tz: string, now: Date): ReactNode {
  const starts = s.times
    .filter((t) => t.kind === "service" && t.startsAt)
    .map((t) => new Date(t.startsAt as string));
  if (starts.length === 0 && s.startsAt) starts.push(new Date(s.startsAt));
  const first = starts[0];
  if (!first) return null;
  const days = calendarDaysBetween(now, first, tz);
  const lead = days <= 0 ? "Today at" : days === 1 ? "Tomorrow at" : `${formatWeekdayInZone(first, tz)} at`;
  return (
    <>
      {lead}{" "}
      {starts.map((d, i) => (
        <span key={d.toISOString()}>
          {i > 0 ? (i === starts.length - 1 ? " and " : ", ") : null}
          <b>{formatTimeInZone(d, tz)}</b>
        </span>
      ))}
    </>
  );
}

function ServicePane({ s, snapshot }: { s: NextService; snapshot: HomeSnapshot }) {
  const now = new Date(snapshot.generatedAt);
  const team = s.team;
  const total = team ? team.confirmed + team.waiting + team.declined : 0;
  return (
    <article className={`${styles.p} ${styles.svc} ${team && total > 0 ? styles.svcTall : ""}`} aria-labelledby="glass-svc">
      <h2 id="glass-svc">
        <span className={styles.sw} style={{ ["--c" as string]: "var(--amber)" }} />
        Next service
        <Link href={s.href}>{s.source === "planning_center" ? "Planning Center" : "Checklist"}</Link>
      </h2>
      <div className={styles.svcName}>{s.title}</div>
      <p className={styles.when}>{whenLine(s, snapshot.timezone, now)}</p>
      {s.seriesTitle ? <p className={styles.series}>{s.seriesTitle}</p> : null}
      {s.startsAt ? (
        <Countdown to={s.startsAt} serverNow={snapshot.generatedAt}>
          {(left) => (
            <div className={`${styles.count} ${styles.num}`}>
              {left.done ? (
                <div>
                  <b>Now</b>
                  <span>under way</span>
                </div>
              ) : left.days > 0 ? (
                <>
                  <div>
                    <b>{left.days}</b>
                    <span>{left.days === 1 ? "day" : "days"}</span>
                  </div>
                  <div>
                    <b>{left.hours}</b>
                    <span>{left.hours === 1 ? "hour" : "hours"}</span>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <b>{left.hours}</b>
                    <span>{left.hours === 1 ? "hour" : "hours"}</span>
                  </div>
                  <div>
                    <b>{String(left.minutes).padStart(2, "0")}</b>
                    <span>minutes</span>
                  </div>
                </>
              )}
            </div>
          )}
        </Countdown>
      ) : null}
      {team && total > 0 ? (
        <>
          <div className={styles.teamglass} aria-hidden="true">
            {Array.from({ length: total }, (_, i) => (
              <i key={i} className={i < team.confirmed ? "" : i < team.confirmed + team.waiting ? styles.u : styles.d} />
            ))}
          </div>
          <p className={styles.teamkey}>
            <b>
              {team.confirmed} of {total}
            </b>{" "}
            confirmed, {team.waiting} waiting, {team.declined} declined
          </p>
          <dl className={styles.roster}>
            {team.positions.map((p) => (
              <div key={p.name} style={{ display: "contents" }}>
                <dt>{p.name}</dt>
                <dd>
                  {p.people.map((person, i) => (
                    <span key={`${person.name}:${i}`}>
                      {i > 0 ? ", " : null}
                      {person.isMe ? "You" : person.name}
                      {person.status !== "confirmed" ? (
                        <span className={`${styles.st} ${person.status === "declined" ? styles.stD : styles.stU}`}>
                          {person.status}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      <div className={styles.actions}>
        <Link className={`${styles.btn} ${styles.btnDark}`} href={s.href}>
          <CalendarDays size={16} aria-hidden="true" />
          {s.source === "planning_center" ? "Open the plan" : "Open the checklist"}
        </Link>
      </div>
    </article>
  );
}

function reason(sec: Section<unknown> | undefined): string {
  if (!sec || sec.state === "ok") return "";
  if (sec.state === "forbidden") return "The system history is only shown to people who can see monitoring.";
  if (sec.state === "unconfigured") return "There is no system history to show yet.";
  return sec.reason ? `The system history is not available right now (${sec.reason}).` : "The system history is not available right now.";
}

export default function GlassLook(props: LookProps) {
  const { me } = props;
  const { snapshot, refresh } = useHomeSnapshot(props.snapshot, INCLUDES);
  const tokens = summarize(snapshot);
  const avail = snapshot.availability;
  const grid = avail && avail.state === "ok" && avail.data.groups.length > 0 ? avail.data : null;

  const canCreate = [
    { key: "tickets", label: "Ticket", href: "/tickets/new", color: "var(--ruby)", icon: <Ticket aria-hidden="true" /> },
    { key: "wiki", label: "Wiki page", href: "/wiki/new", color: "var(--cobalt)", icon: <BookOpen aria-hidden="true" /> },
    { key: "notes", label: "Note", href: "/notes", color: "var(--amber)", icon: <StickyNote aria-hidden="true" /> },
  ].filter((c) => me.access[c.key] !== undefined);
  const activity = snapshot.activity.state === "ok" ? snapshot.activity.data.slice(0, 3) : [];
  const showStart = canCreate.length > 0 || activity.length > 0;

  return (
    <main data-look="glass" className={`${font.variable} ${styles.root}`}>
      <div className={styles.wrap}>
        <section className={styles.intro}>
          <div>
            <p className={styles.hi}>
              {DAY_PART_GREETING[snapshot.dayPart]}, {snapshot.user.firstName}.
            </p>
            <h1 className={styles.h1}>
              {tokens.length === 0
                ? snapshot.site.name
                : tokens.map((t, i) =>
                    t.kind === "link" ? (
                      <Link key={i} href={t.href} className={TONE_CLASS[t.tone]}>
                        {t.text}
                      </Link>
                    ) : (
                      <span key={i}>{t.text}</span>
                    ),
                  )}
            </h1>
          </div>
          <div className={styles.introSide}>
            {grid ? (
              <div className={styles.legend} aria-hidden="true">
                <span>Each pane is one hour of one system</span>
                <span>
                  <i className={styles.legendUp} />
                  Lit: up
                </span>
                <span>
                  <i className={styles.legendDown} />
                  Dark: down
                </span>
              </div>
            ) : null}
            <LookPickerButton className={styles.pickerBtn} />
          </div>
        </section>

        <section aria-label="Uptime of every system over the last 12 hours">
          {grid ? (
            <GlassWindow grid={grid} />
          ) : avail && avail.state === "ok" ? (
            <p className={styles.windowOff}>History builds up over the first 12 hours. Nothing has been recorded yet.</p>
          ) : (
            <p className={styles.windowOff}>{reason(avail) || "The system history is not available right now."}</p>
          )}
        </section>

        <div className={styles.leaded}>
          {snapshot.service.state === "ok" ? <ServicePane s={snapshot.service.data} snapshot={snapshot} /> : null}

          {snapshot.needs.state === "ok" ? (
            <article className={styles.p} aria-labelledby="glass-needs">
              <h2 id="glass-needs">
                <span className={styles.sw} style={{ ["--c" as string]: "var(--ruby)" }} />
                For you
                {me.access.tickets !== undefined ? <Link href="/tickets">Help desk</Link> : null}
              </h2>
              {snapshot.needs.data.length === 0 ? (
                <p className={styles.empty}>Nothing needs you right now.</p>
              ) : (
                <ul className={styles.list}>
                  {snapshot.needs.data.slice(0, 5).map((n) => (
                    <li key={n.id}>
                      <div className={styles.row}>
                        <span className={styles.chip} style={{ ["--c" as string]: n.severity === "urgent" ? "var(--ruby)" : n.source === "system" ? "var(--amethyst)" : n.source === "checklist" ? "var(--emerald)" : "var(--cobalt)" }}>
                          {n.source === "checklist" ? <CalendarDays aria-hidden="true" /> : <Ticket aria-hidden="true" />}
                        </span>
                        <span>
                          <Link href={n.href} className={styles.t}>
                            {n.title}
                          </Link>
                          <span className={styles.m}>
                            {n.context}
                            {n.severity === "urgent" && n.dueAt ? (
                              <>
                                {" "}
                                <span className={styles.due}>
                                  Due <RelativeTime at={n.dueAt} serverNow={snapshot.generatedAt} />
                                </span>
                              </>
                            ) : null}
                          </span>
                          {n.actions.length > 0 ? (
                            <span className={styles.needActions} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {n.actions.map((a, i) => (
                                <NeedActionButton
                                  key={i}
                                  action={a}
                                  meId={snapshot.user.id}
                                  onChanged={() => void refresh()}
                                  buttonClassName={styles.needBtn}
                                />
                              ))}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ) : null}

          {showStart ? (
            <article className={styles.p} aria-labelledby="glass-start">
              <h2 id="glass-start">
                <span className={styles.sw} style={{ ["--c" as string]: "var(--emerald)" }} />
                Start something
              </h2>
              {canCreate.length > 0 ? (
                <div className={styles.make}>
                  {canCreate.map((c) => (
                    <Link key={c.key} href={c.href}>
                      <span className={styles.chip} style={{ ["--c" as string]: c.color }}>
                        {c.icon}
                      </span>
                      {c.label}
                    </Link>
                  ))}
                </div>
              ) : null}
              {activity.length > 0 ? (
                <ul className={styles.feed} aria-label="Recent activity">
                  {activity.map((a) => (
                    <li key={a.id}>
                      <i />
                      <span>
                        {a.actorName ? <b>{a.actorName}</b> : null}
                        {a.actorName ? " " : null}
                        {a.href ? <Link href={a.href}>{a.summary}</Link> : a.summary},{" "}
                        <RelativeTime at={a.at} serverNow={snapshot.generatedAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ) : null}

          {snapshot.wiki.state === "ok" ? (
            <article className={`${styles.p} ${styles.wide}`} aria-labelledby="glass-wiki">
              <h2 id="glass-wiki">
                <span className={styles.sw} style={{ ["--c" as string]: "var(--cobalt)" }} />
                Changed in the wiki
                <Link href="/wiki">Browse</Link>
              </h2>
              {snapshot.wiki.data.recent.length === 0 ? (
                <p className={styles.empty}>No wiki pages yet.</p>
              ) : (
                <ul className={styles.list}>
                  {snapshot.wiki.data.recent.map((w) => (
                    <li key={w.id}>
                      <Link href={w.href} className={styles.wikiRow}>
                        <span className={styles.t}>{w.title}</span>
                        <span className={styles.m}>
                          {w.updatedByName ? `${w.updatedByName}, ` : ""}
                          <RelativeTime at={w.updatedAt} serverNow={snapshot.generatedAt} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ) : null}
        </div>
      </div>
    </main>
  );
}
