"use client";

import Link from "next/link";
import { Activity, ListChecks, Users } from "lucide-react";
import { rankNeeds, type HomeSnapshot, type NextService } from "@church/shared";
import { NeedActionButton } from "../../parts/need-action";
import { NEED_KIND, needsHeadline, systemsCount, systemsProblem, teamHeadline } from "./nave-format";
import s from "./nave.module.css";

/** A window is shown unless the person may not have it at all (forbidden) or it is not set up. */
export function windowWanted(section: { state: string }): boolean {
  return section.state !== "forbidden" && section.state !== "unconfigured";
}

export function SystemsWindow({ section }: { section: HomeSnapshot["systems"] }) {
  if (!windowWanted(section)) return null;
  return (
    <article className={s.window} aria-labelledby="nave-systems">
      <header className={s.windowHead}>
        <Activity className={s.icon} aria-hidden />
        <h2 id="nave-systems" className={s.windowTitle}>
          Systems
        </h2>
        {section.state === "ok" ? (
          <p className={s.num}>
            {systemsCount(section.data)}
            {systemsProblem(section.data) ? <em className={s.bad}> {systemsProblem(section.data)}</em> : null}
            {section.data.maintenanceMode ? " Alerts are paused for maintenance." : ""}
          </p>
        ) : (
          <p>Systems could not be read just now.</p>
        )}
      </header>
      {section.state === "ok" ? (
        <ul className={`${s.rows} ${s.num}`}>
          {section.data.areas
            .filter((a) => a.state !== "forbidden")
            .map((a) => {
              const down = a.state === "ok" && a.down > 0;
              const muted = a.state === "unconfigured" || a.state === "unavailable";
              return (
                <li key={a.key}>
                  <Link href={a.href} className={`${s.row} ${down ? s.rowBad : ""} ${muted ? s.rowMuted : ""}`}>
                    <span className={`${s.lamp} ${down ? s.lampOut : ""} ${muted ? s.lampOff : ""}`} aria-hidden />
                    <span className={s.rowLabel}>
                      {a.label}
                      {down ? <span className={s.srOnly}>, needs attention</span> : null}
                    </span>
                    <span className={s.rowValue}>
                      {a.state === "ok"
                        ? `${a.up} of ${a.total}`
                        : a.state === "unconfigured"
                          ? "Not set up"
                          : (a.note ?? "Cannot reach")}
                    </span>
                  </Link>
                </li>
              );
            })}
        </ul>
      ) : null}
    </article>
  );
}

type Team = NonNullable<NextService["team"]>;

export function TeamWindow({ team }: { team: Team }) {
  return (
    <article className={s.window} aria-labelledby="nave-team">
      <header className={s.windowHead}>
        <Users className={s.icon} aria-hidden />
        <h2 id="nave-team" className={s.windowTitle}>
          Sunday&apos;s team
        </h2>
        <p>{teamHeadline(team)}</p>
      </header>
      <dl className={s.roster}>
        {team.positions.map((p) => (
          <div key={p.name} className={s.rosterRow}>
            <dt>{p.name}</dt>
            <dd>
              {p.people.length === 0 ? <span className={`${s.tag} ${s.tagDeclined}`}>nobody yet</span> : null}
              {p.people.map((x, i) => (
                <span key={`${x.name}-${i}`} className={s.person}>
                  <span className={x.isMe ? s.me : undefined}>{x.isMe ? "You" : x.name}</span>
                  {x.status === "waiting" ? <span className={`${s.tag} ${s.tagWaiting}`}>waiting</span> : null}
                  {x.status === "declined" ? <span className={`${s.tag} ${s.tagDeclined}`}>declined</span> : null}
                  {i < p.people.length - 1 ? ", " : ""}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export function NeedsWindow({
  section,
  meId,
  onChanged,
}: {
  section: HomeSnapshot["needs"];
  meId: string;
  onChanged: () => void;
}) {
  if (!windowWanted(section)) return null;
  const ranked = section.state === "ok" ? rankNeeds(section.data) : [];
  const shown = ranked.slice(0, 4);
  return (
    <article className={s.window} aria-labelledby="nave-needs">
      <header className={s.windowHead}>
        <ListChecks className={s.icon} aria-hidden />
        <h2 id="nave-needs" className={s.windowTitle}>
          For you
        </h2>
        <p>{section.state === "ok" ? needsHeadline(ranked) : "This could not be read just now."}</p>
      </header>
      {shown.length > 0 ? (
        <ul className={s.tasks}>
          {shown.map((n) => {
            const actions = n.actions.filter((a) => !(a.kind === "link" && a.href === n.href));
            return (
              <li key={n.id}>
                <Link href={n.href} className={s.taskLink}>
                  <span className={s.kind}>
                    {NEED_KIND[n.source]}
                    {n.severity === "urgent" ? ", urgent" : ""}
                  </span>
                  <span className={s.taskTitle}>{n.title}</span>
                  <span className={s.taskMeta}>{n.context}</span>
                </Link>
                {actions.length > 0 ? (
                  <div className={s.taskActions}>
                    {actions.map((a, i) => (
                      <NeedActionButton
                        key={`${a.kind}-${i}`}
                        action={a}
                        meId={meId}
                        onChanged={onChanged}
                        className={s.actionWrap}
                        buttonClassName={s.actionBtn}
                      />
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {ranked.length > shown.length ? (
        <p className={s.more}>and {ranked.length - shown.length} more</p>
      ) : null}
    </article>
  );
}
