"use client";

import { formatWeekdayInZone } from "@church/shared";
import type { LookProps } from "../../look-props";
import { useSectionHidden } from "../../home-look-context";
import { useHomeSnapshot } from "../../use-home-snapshot";
import { archivo } from "./font";
import { Hero } from "./hero";
import { LowerRow } from "./lower-row";
import { serviceStart } from "./model";
import { ReadinessStrip } from "./readiness-strip";
import styles from "./toward-sunday.module.css";
import { useNow } from "./use-now";
import { WeekRail } from "./week-rail";

const INCLUDES = ["week", "readiness"] as const;

export default function TowardSundayLook(props: LookProps) {
  const { snapshot, refresh } = useHomeSnapshot(props.snapshot, INCLUDES);
  const hidden = useSectionHidden();
  const now = useNow(snapshot.generatedAt);
  const tz = snapshot.timezone;

  const service = snapshot.service.state === "ok" ? snapshot.service.data : null;
  const week = snapshot.week?.state === "ok" ? snapshot.week.data : null;
  const readiness = snapshot.readiness?.state === "ok" ? snapshot.readiness.data : null;
  const start = service ? serviceStart(service) : null;
  const weekday = start ? formatWeekdayInZone(start, tz) : null;

  return (
    <main data-look="toward-sunday" className={`${styles.root} ${archivo.variable}`}>
      <div className={styles.wrap}>
        <Hero snapshot={snapshot} service={service} now={now} />

        <section aria-labelledby="ts-week-h">
          <h2 id="ts-week-h" className={styles.sr}>
            This week
          </h2>
          {week ? (
            <WeekRail week={week} service={service} now={now} tz={tz} showHealth={snapshot.systems.state !== "forbidden"} />
          ) : (
            <p className={styles.notice} data-testid="week-unavailable">
              The week view could not be loaded just now. It will try again shortly.
            </p>
          )}
        </section>

        {readiness && !hidden("readiness") ? (
          <ReadinessStrip
            readiness={readiness}
            title={weekday ? `Ready for ${weekday}` : "Ready check"}
            hasService={service !== null}
          />
        ) : null}

        <LowerRow
          snapshot={snapshot}
          me={props.me}
          refresh={refresh}
          service={service}
          teamTitle={weekday ? `${weekday}'s team` : "Team"}
          weekStart={week?.weekStart ?? null}
          hidden={hidden}
        />
      </div>
    </main>
  );
}
