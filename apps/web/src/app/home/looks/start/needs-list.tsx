"use client";

import Link from "next/link";
import { ListChecks, Ticket, UserX, WifiOff } from "lucide-react";
import { formatWeekdayInZone, rankNeeds, type HomeSnapshot, type NeedItem } from "@church/shared";
import { NeedActionButton } from "../../parts/need-action";
import { RelativeTime } from "../../parts/relative-time";
import s from "./styles.module.css";

const SOURCE_ICON = { ticket: Ticket, system: WifiOff, team: UserX, checklist: ListChecks } as const;

function toneClass(item: NeedItem): string {
  if (item.severity === "urgent") return s.hot ?? "";
  if (item.severity === "soon") return s.wait ?? "";
  if (item.source === "checklist") return s.task ?? "";
  return "";
}

function groupHeading(group: NeedItem["group"], snapshot: HomeSnapshot): string {
  if (group === "this_week") return "This week";
  if (group === "later") return "Later";
  if (snapshot.service.state === "ok" && snapshot.service.data.startsAt) {
    return `Before ${formatWeekdayInZone(new Date(snapshot.service.data.startsAt), snapshot.timezone)}`;
  }
  return "Soon";
}

export function NeedsSection({ snapshot, refresh }: { snapshot: HomeSnapshot; refresh: () => void }) {
  const needs = snapshot.needs;
  if (needs.state !== "ok") {
    return (
      <section aria-labelledby="start-needs-h">
        <div className={s.secH}>
          <h2 id="start-needs-h">Needs you</h2>
        </div>
        <p className={s.quiet}>The list of things that need you can't be shown right now.</p>
      </section>
    );
  }
  const ranked = rankNeeds(needs.data);
  const primaryId = ranked[0]?.id;
  const groups = (["before_service", "this_week", "later"] as const)
    .map((g) => ({ group: g, items: ranked.filter((n) => n.group === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <section aria-labelledby="start-needs-h">
      <div className={s.secH}>
        <h2 id="start-needs-h">Needs you</h2>
        {ranked.length > 0 ? <span className={s.num}>{ranked.length === 1 ? "1 thing" : `${ranked.length} things`}</span> : null}
      </div>
      {ranked.length === 0 ? <p className={s.empty}>Nothing needs you right now.</p> : null}
      {groups.map(({ group, items }) => (
        <div key={group} className={s.groupWrap}>
          <h3 className={s.groupH}>{groupHeading(group, snapshot)}</h3>
          <ul className={s.needs}>
            {items.map((item) => {
              const Icon = SOURCE_ICON[item.source];
              return (
                <li key={item.id} className={`${s.need} ${toneClass(item)}`}>
                  <span className={s.ic} aria-hidden>
                    <Icon className={s.icon} />
                  </span>
                  <span>
                    <Link href={item.href} className={s.t}>
                      {item.title}
                    </Link>
                    <span className={`${s.m} ${s.num}`}>
                      {item.context}
                      {item.dueAt ? (
                        <>
                          {item.context ? ". " : ""}
                          <b>
                            Due <RelativeTime at={item.dueAt} serverNow={snapshot.generatedAt} />
                          </b>
                        </>
                      ) : null}
                    </span>
                  </span>
                  {item.actions.length > 0 ? (
                    <span className={s.acts}>
                      {item.actions.map((a, i) => (
                        <NeedActionButton
                          key={`${a.kind}-${i}`}
                          action={a}
                          meId={snapshot.user.id}
                          onChanged={refresh}
                          buttonClassName={`${s.act} ${item.id === primaryId && i === 0 ? s.actPrimary : ""}`}
                        />
                      ))}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
