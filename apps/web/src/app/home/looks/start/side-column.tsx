"use client";

import Link from "next/link";
import { BookOpen, FileText } from "lucide-react";
import { formatTimeInZone, zonedParts, type HomeSnapshot } from "@church/shared";
import { Countdown } from "../../parts/countdown";
import { RelativeTime } from "../../parts/relative-time";
import s from "./styles.module.css";

function weekdayShort(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d);
}

function ServiceCard({ snapshot }: { snapshot: HomeSnapshot }) {
  const sec = snapshot.service;
  if (sec.state === "forbidden") return null;
  // Nothing scheduled that this person can see is not an error: say nothing.
  if (sec.state === "unavailable" && sec.reason === "no upcoming service") return null;
  if (sec.state !== "ok") {
    return (
      <section className={s.card} aria-labelledby="start-svc-h">
        <h2 id="start-svc-h">Next service</h2>
        <p className={s.quiet}>
          {sec.state === "unconfigured" ? "Planning Center isn't set up." : "Planning Center can't be reached right now."}
        </p>
      </section>
    );
  }
  const svc = sec.data;
  const tz = snapshot.timezone;
  const start = svc.startsAt ? new Date(svc.startsAt) : null;
  const serviceTimes = svc.times
    .filter((t) => t.kind === "service" && t.startsAt)
    .map((t) => formatTimeInZone(new Date(t.startsAt as string), tz));
  const timesText =
    serviceTimes.length > 1
      ? `${serviceTimes.slice(0, -1).join(", ")} and ${serviceTimes[serviceTimes.length - 1]}`
      : (serviceTimes[0] ?? (start ? formatTimeInZone(start, tz) : ""));
  const team = svc.team;
  const total = team ? team.confirmed + team.waiting + team.declined : 0;
  return (
    <section className={s.card} aria-labelledby="start-svc-h">
      <h2 id="start-svc-h">
        Next service <Link href={svc.href}>Plan</Link>
      </h2>
      <div className={s.sunday}>
        {start ? (
          <div className={s.date} aria-hidden>
            <span>{weekdayShort(start, tz)}</span>
            <b className={s.num}>{zonedParts(start, tz).day}</b>
          </div>
        ) : (
          <div />
        )}
        <div>
          <div className={s.sundayName}>{svc.title}</div>
          <div className={`${s.sundayWhen} ${s.num}`}>
            {timesText}
            {start ? (
              <>
                {timesText ? ", in " : "In "}
                <Countdown to={start} serverNow={snapshot.generatedAt} />
              </>
            ) : null}
          </div>
        </div>
      </div>
      {team && total > 0 ? (
        <div className={s.team}>
          <div className={s.bar} aria-hidden>
            {team.confirmed > 0 ? <i className={s.segOk} style={{ flex: team.confirmed }} /> : null}
            {team.waiting > 0 ? <i className={s.segWait} style={{ flex: team.waiting }} /> : null}
            {team.declined > 0 ? <i className={s.segNo} style={{ flex: team.declined }} /> : null}
          </div>
          <p className={s.num}>
            {team.confirmed} confirmed, {team.waiting} waiting, {team.declined} declined
          </p>
        </div>
      ) : null}
    </section>
  );
}

function SystemsCard({ snapshot }: { snapshot: HomeSnapshot }) {
  const sec = snapshot.systems;
  if (sec.state !== "ok") return null;
  const areas = sec.data.areas.filter((a) => a.state !== "forbidden");
  if (areas.length === 0) return null;
  return (
    <section className={s.card} aria-labelledby="start-sys-h">
      <h2 id="start-sys-h">
        Systems <Link href="/monitoring">Monitoring</Link>
      </h2>
      <ul className={`${s.health} ${s.num}`}>
        {areas.map((a) => {
          const ok = a.state === "ok";
          const text = !ok
            ? (a.note ?? (a.state === "unconfigured" ? "Not set up" : "Unavailable"))
            : a.down > 0
              ? `${a.down} down`
              : a.total > 0
                ? `${a.up} up`
                : (a.note ?? "Nothing monitored");
          return (
            <li key={a.key} className={ok && a.down > 0 ? s.bad : ""}>
              <Link href={a.href}>
                <span className={`${s.d} ${ok ? "" : s.dOff}`} aria-hidden />
                <span className={s.l}>{a.label}</span>
                <span className={s.v}>{text}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface RecentItem {
  id: string;
  kind: "Wiki" | "Note";
  title: string;
  href: string;
  updatedAt: string;
}

function RecentCard({ snapshot }: { snapshot: HomeSnapshot }) {
  const items: RecentItem[] = [];
  if (snapshot.wiki.state === "ok") {
    for (const w of snapshot.wiki.data.recent) items.push({ id: `w-${w.id}`, kind: "Wiki", title: w.title, href: w.href, updatedAt: w.updatedAt });
  }
  if (snapshot.notes.state === "ok") {
    for (const n of snapshot.notes.data.recent) items.push({ id: `n-${n.id}`, kind: "Note", title: n.title, href: n.href, updatedAt: n.updatedAt });
  }
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const top = items.slice(0, 4);
  if (top.length === 0) return null;
  return (
    <section className={s.card} aria-labelledby="start-recent-h">
      <h2 id="start-recent-h">Recently changed</h2>
      <ul className={s.recent}>
        {top.map((it) => {
          const Icon = it.kind === "Wiki" ? BookOpen : FileText;
          return (
            <li key={it.id}>
              <Link href={it.href}>
                <Icon aria-hidden />
                <span className={s.rt}>
                  {it.title}
                  <small>
                    {it.kind}, updated <RelativeTime at={it.updatedAt} serverNow={snapshot.generatedAt} />
                  </small>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SideColumn({
  snapshot,
  hidden,
  wide,
}: {
  snapshot: HomeSnapshot;
  hidden: (id: string) => boolean;
  wide: boolean;
}) {
  return (
    <aside className={`${s.side} ${wide ? s.sideWide : ""}`} aria-label="Service, systems and recent changes">
      {hidden("service") ? null : <ServiceCard snapshot={snapshot} />}
      {hidden("systems") ? null : <SystemsCard snapshot={snapshot} />}
      {hidden("recent") ? null : <RecentCard snapshot={snapshot} />}
    </aside>
  );
}
