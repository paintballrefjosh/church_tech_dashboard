"use client";

import { formatWeekdayInZone, type HomeSnapshot, type NextService } from "@church/shared";
import { Countdown } from "../../parts/countdown";
import { LookPickerButton } from "../../picker/look-picker";
import { countdownTarget, dayAndMonth, serviceStart, whenPhrase } from "./model";
import styles from "./toward-sunday.module.css";

export function Hero({
  snapshot,
  service,
  now,
}: {
  snapshot: HomeSnapshot;
  service: NextService | null;
  now: Date;
}) {
  const tz = snapshot.timezone;
  const start = service ? serviceStart(service) : null;
  const target = service ? countdownTarget(service, now) : null;
  const hasFutureService = service
    ? service.times.some((t) => t.kind === "service" && t.startsAt !== null && Date.parse(t.startsAt) > now.getTime())
    : false;
  const part = snapshot.dayPart;
  const when = `${formatWeekdayInZone(now, tz)} ${part}, ${dayAndMonth(now, tz)}.`;
  const hello = snapshot.user.firstName ? `Good ${part}, ${snapshot.user.firstName}.` : `Good ${part}.`;

  return (
    <div className={styles.hero}>
      <div className={styles.heroHead}>
        <div>
          <div className={styles.whenRow}>
            <p className={styles.when}>
              {when} {hello}
            </p>
            <LookPickerButton className={styles.picker} />
          </div>
          <h1 className={styles.title}>
            {service ? (
              <>
                {service.title}
                <br />
                {start ? whenPhrase(start, now, tz) : "is coming up"}
              </>
            ) : (
              "Your week"
            )}
          </h1>
        </div>
        {target ? (
          <div className={styles.countdown}>
            <Countdown to={target} serverNow={snapshot.generatedAt}>
              {(left) =>
                left.done ? (
                  <p className={styles.big}>Under way</p>
                ) : (
                  <>
                    <p className={`${styles.big} ${styles.num}`} aria-hidden="true">
                      {left.days > 0 ? (
                        <>
                          <b>{left.days}</b>d <b>{left.hours}</b>h
                        </>
                      ) : (
                        <>
                          <b>{left.hours}</b>h <b>{String(left.minutes).padStart(2, "0")}</b>m
                        </>
                      )}
                    </p>
                    <span className={styles.sr}>
                      {left.days > 0 ? `${left.days} days ${left.hours} hours` : `${left.hours} hours ${left.minutes} minutes`}
                    </span>
                  </>
                )
              }
            </Countdown>
            <p className={styles.cdLabel}>{hasFutureService ? "until the first service" : "until it starts"}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
