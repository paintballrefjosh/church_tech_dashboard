"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatTimeInZone, type NextService, type WeekDigest } from "@church/shared";
import { dayFraction, dayIndexOf, serviceStart } from "./model";
import styles from "./toward-sunday.module.css";

type Day = WeekDigest["days"][number];
type DayEvent = Day["events"][number];

const TONE_CLASS: Record<DayEvent["tone"], string> = {
  ok: styles.toneOk ?? "",
  warn: styles.toneWarn ?? "",
  bad: styles.toneBad ?? "",
  info: styles.toneInfo ?? "",
};

const CELL_CLASS: Record<Day["health"][number], string> = {
  up: "",
  none: styles.cNone ?? "",
  partial: styles.cPartial ?? "",
  down: styles.cDown ?? "",
  future: styles.cFuture ?? "",
};

const FULL_DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

function weekdayLong(date: string): string {
  return WEEKDAY.format(new Date(`${date}T12:00:00Z`));
}

function fullDate(date: string): string {
  return FULL_DATE.format(new Date(`${date}T12:00:00Z`));
}

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function healthSummary(cells: Day["health"]): string {
  const bad = cells.filter((c) => c === "down" || c === "partial").length;
  if (bad > 0) return `Problems in ${bad} ${bad === 1 ? "hour" : "hours"}`;
  if (cells.some((c) => c === "up")) return "All systems up";
  return "No health data";
}

function EventRow({ ev }: { ev: DayEvent }) {
  const cls = `${styles.ev} ${TONE_CLASS[ev.tone]}`;
  const body = (
    <>
      <b>{ev.title}</b>
      {ev.detail}
    </>
  );
  return ev.href ? (
    <Link href={ev.href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function ServiceCards({ service, tz }: { service: NextService; tz: string }) {
  const timed = service.times
    .filter((t) => t.kind === "service" && t.startsAt)
    .map((t) => ({ id: t.id, at: new Date(t.startsAt as string), name: t.name }));
  if (timed.length === 0) {
    const start = serviceStart(service);
    if (start) timed.push({ id: "start", at: start, name: null });
  }
  return (
    <ul className={styles.svc}>
      {timed.map((t, i) => (
        <li key={t.id}>
          <Link href={service.href}>
            <span className={`${styles.svcTime} ${styles.num}`}>{formatTimeInZone(t.at, tz)}</span>
            <span className={styles.svcName}>{t.name ?? (timed.length > 1 ? (i === 0 ? "First service" : "Service") : "Service")}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ServiceMeta({ service, tz }: { service: NextService; tz: string }) {
  const extra = service.times
    .filter((t) => t.kind !== "service" && t.startsAt)
    .map((t) => `${t.name ?? (t.kind === "rehearsal" ? "Rehearsal" : "Also")} at ${formatTimeInZone(new Date(t.startsAt as string), tz)}`);
  const team = service.team;
  const total = team ? team.confirmed + team.waiting + team.declined : 0;
  if (!service.seriesTitle && extra.length === 0 && total === 0) return null;
  return (
    <p className={`${styles.sunMeta} ${styles.num}`}>
      {service.seriesTitle ? <strong>{service.seriesTitle}. </strong> : null}
      {extra.length > 0 ? `${extra.join(", ")}. ` : null}
      {total > 0 && team ? `${team.confirmed} of ${total} on the team have confirmed.` : null}
    </p>
  );
}

export function WeekRail({
  week,
  service,
  now,
  tz,
  showHealth,
}: {
  week: WeekDigest;
  service: NextService | null;
  now: Date;
  tz: string;
  showHealth: boolean;
}) {
  const svcIdx = service ? dayIndexOf(week, serviceStart(service), tz) : -1;
  const template = week.days.map((_, i) => (i === svcIdx ? "minmax(270px, 2.1fr)" : "minmax(118px, 1fr)")).join(" ");
  const todayIdx = week.days.findIndex((d) => d.isToday);
  const frac = dayFraction(now, tz);

  const scroller = useRef<HTMLDivElement>(null);
  const todayEl = useRef<HTMLDivElement>(null);
  const [travelFrom, setTravelFrom] = useState<number | null>(null);

  // On mount: scroll the rail so today is in view (phones), then let the marker travel in once.
  useEffect(() => {
    const sc = scroller.current;
    const td = todayEl.current;
    if (!sc || !td) return;
    const maxLeft = Math.max(0, sc.scrollWidth - sc.clientWidth);
    sc.scrollLeft = Math.min(maxLeft, Math.max(0, td.offsetLeft - 8));
    const x = td.offsetLeft + td.offsetWidth * dayFraction(new Date(), tz);
    setTravelFrom(-x);
    // Once on load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nowStyle = { left: `${frac * 100}%`, "--from": `${travelFrom ?? 0}px` } as CSSProperties;

  return (
    <div className={styles.railCard}>
      <div className={styles.railScroll} ref={scroller} data-testid="week-rail-scroll">
        <div className={styles.rail} style={{ gridTemplateColumns: template }} data-testid="week-rail">
          {week.days.map((d, i) => {
            const isService = i === svcIdx && service !== null;
            const cls = [styles.day, d.isPast ? styles.past : "", d.isToday ? styles.today : "", isService ? styles.sunday : ""]
              .filter(Boolean)
              .join(" ");
            const events = isService ? d.events.filter((e) => e.kind !== "service") : d.events;
            return (
              <div
                key={d.date}
                className={cls}
                data-testid="week-day"
                data-today={d.isToday ? "true" : undefined}
                data-service-day={isService ? "true" : undefined}
                aria-current={d.isToday ? "date" : undefined}
                ref={d.isToday ? todayEl : undefined}
              >
                <h3 className={styles.dhead}>
                  <span className={styles.sr}>{fullDate(d.date)}</span>
                  <span className={styles.dnum} aria-hidden="true">
                    {dayNumber(d.date)}
                  </span>
                  <span className={styles.dname} aria-hidden="true">
                    {isService ? weekdayLong(d.date) : d.label}
                  </span>
                </h3>
                {isService && service ? (
                  <>
                    <ServiceCards service={service} tz={tz} />
                    <ServiceMeta service={service} tz={tz} />
                  </>
                ) : null}
                {events.length > 0 || d.moreCount > 0 ? (
                  <ul className={styles.events}>
                    {events.map((e, j) => (
                      <li key={`${e.at}-${j}`}>
                        <EventRow ev={e} />
                      </li>
                    ))}
                    {d.moreCount > 0 ? <li className={styles.more}>+{d.moreCount} more</li> : null}
                  </ul>
                ) : (
                  <p className={styles.events}>
                    <span className={styles.quiet}>{d.isPast ? "Nothing logged." : "Nothing yet."}</span>
                  </p>
                )}
                {showHealth ? (
                  <div className={styles.health} role="img" aria-label={`Systems health by hour: ${healthSummary(d.health)}`}>
                    {d.health.map((c, k) => (
                      <i key={k} className={CELL_CLASS[c]} />
                    ))}
                  </div>
                ) : (
                  <div className={styles.noHealth} />
                )}
                {d.isToday && todayIdx === i ? (
                  <div
                    className={`${styles.now} ${travelFrom !== null ? styles.nowReady : ""}`}
                    style={nowStyle}
                    data-testid="week-now"
                    aria-hidden="true"
                  >
                    <span>Now</span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
