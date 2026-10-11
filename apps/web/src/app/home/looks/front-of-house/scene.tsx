"use client";

import Link from "next/link";
import { formatTimeInZone, summarize, type HomeSnapshot, type NextService } from "@church/shared";
import { Countdown } from "../../parts/countdown";
import type { LookProps } from "../../look-props";
import { serviceDateLine, useNow } from "./format";
import s from "./front-of-house.module.css";

const KIND_LABEL: Record<NextService["times"][number]["kind"], string> = {
  service: "service",
  rehearsal: "rehearsal",
  other: "",
};

const pad = (n: number) => String(n).padStart(2, "0");

function ledClass(team: NonNullable<NextService["team"]>): string | undefined {
  return team.waiting > 0 || team.declined > 0 ? s.ledA : s.ledG;
}

/** The console's main screen: what is next, the show clock and the run sheet. */
export function Scene({ props }: { props: LookProps }) {
  const { snapshot, me } = props;
  const now = useNow(snapshot.generatedAt, 30_000);
  const greeting = `Good ${snapshot.dayPart}, ${snapshot.user.firstName}.`;

  if (snapshot.service.state !== "ok") {
    return <SceneNoService snapshot={snapshot} greeting={greeting} />;
  }
  const service = snapshot.service.data;
  const tz = snapshot.timezone;
  const nowMs = now.getTime();
  const firstService = service.times.find(
    (t) => t.kind === "service" && t.startsAt !== null && Date.parse(t.startsAt) > nowMs,
  );
  const nextTime = service.times.find((t) => t.startsAt !== null && Date.parse(t.startsAt) > nowMs);
  const when = service.startsAt ? serviceDateLine(new Date(service.startsAt), now, tz) : null;
  const team = service.team;
  const total = team ? team.confirmed + team.waiting + team.declined : 0;
  const hasChecklists = "checklists" in me.access;

  return (
    <section className={`${s.scene} ${s.screen}`} aria-labelledby="foh-service">
      <div>
        <p className={s.now}>{greeting} Up next:</p>
        <h1 id="foh-service">{service.title}</h1>
        <p className={s.sub}>
          {when ? `${when}. ` : null}
          {service.seriesTitle ? <b>{service.seriesTitle}</b> : null}
          {service.seriesTitle && service.serviceTypeName ? `, ${service.serviceTypeName}` : service.serviceTypeName}
        </p>
        <div className={s.sceneActs}>
          <Link className={s.key} href={service.href}>
            Open the plan
          </Link>
          {hasChecklists ? (
            <Link className={s.key} href="/checklists">
              Sunday checklists
            </Link>
          ) : null}
          {team ? (
            <span className={`${s.teamline} ${s.num}`}>
              <span className={`${s.led} ${ledClass(team)}`} aria-hidden />
              Team {team.confirmed} of {total} confirmed
            </span>
          ) : null}
        </div>
      </div>
      {firstService?.startsAt ? (
        <div className={s.clock} role="timer" aria-label="Time until the first service">
          <Countdown to={firstService.startsAt} granularity="second" serverNow={snapshot.generatedAt}>
            {(left) => (
              <div className={`${s.clockTime} ${s.num}`} suppressHydrationWarning>
                {pad(left.days * 24 + left.hours)}:{pad(left.minutes)}:{pad(left.seconds)}
              </div>
            )}
          </Countdown>
          <div className={s.clockLabel}>until the first service</div>
        </div>
      ) : null}
      {service.times.length > 0 ? (
        <div className={s.rs}>
          <h2 className={s.runsheetH}>Run sheet</h2>
          <ul className={`${s.runsheet} ${s.num}`}>
            {service.times.map((t) => {
              const label = t.name ?? (KIND_LABEL[t.kind] || "Item");
              const kind = t.name && KIND_LABEL[t.kind] ? KIND_LABEL[t.kind] : "";
              const isNext = nextTime?.id === t.id;
              return (
                <li key={t.id} className={isNext ? s.next : undefined} aria-current={isNext ? "step" : undefined}>
                  <span className={s.tm}>{t.startsAt ? formatTimeInZone(new Date(t.startsAt), tz) : "TBC"}</span>
                  <span>
                    {label}
                    {kind ? <span className={s.kindTag}>{kind}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function SceneNoService({ snapshot, greeting }: { snapshot: HomeSnapshot; greeting: string }) {
  const tokens = summarize(snapshot);
  return (
    <section className={`${s.scene} ${s.sceneSolo} ${s.screen}`} aria-labelledby="foh-greeting">
      <div>
        <h1 id="foh-greeting">{greeting}</h1>
        <p className={s.sentence}>
          {tokens.map((t, i) =>
            t.kind === "text" ? (
              <span key={i}>{t.text}</span>
            ) : (
              <Link
                key={i}
                href={t.href}
                className={t.tone === "ok" ? s.toneOk : t.tone === "warn" ? s.toneWarn : s.toneBad}
              >
                {t.text}
              </Link>
            ),
          )}
        </p>
      </div>
    </section>
  );
}
