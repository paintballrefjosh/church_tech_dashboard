"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { BookOpen, FileText, ListChecks, Server, Ticket, Users } from "lucide-react";
import { formatWeekdayInZone, type HomeSnapshot, type NeedItem, type NextService } from "@church/shared";
import { NeedActionButton } from "../../parts/need-action";
import type { LookProps } from "../../look-props";
import { dateKey } from "./model";
import styles from "./toward-sunday.module.css";

const NEEDS_SHOWN = 5;

const NEED_ICON: Record<NeedItem["source"], ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  ticket: Ticket,
  system: Server,
  team: Users,
  checklist: ListChecks,
};

function NeedsPanel({
  snapshot,
  refresh,
}: {
  snapshot: HomeSnapshot;
  refresh: () => Promise<void>;
}) {
  const needs = snapshot.needs;
  const ticketsLink = snapshot.tickets.state === "ok" ? (
    <Link href="/tickets">Help desk</Link>
  ) : null;
  return (
    <section className={styles.panel} aria-labelledby="ts-needs-h" data-testid="needs-panel">
      <h2 id="ts-needs-h">
        Needs you {ticketsLink}
      </h2>
      {needs.state !== "ok" ? (
        <p className={styles.empty}>This could not be loaded just now.</p>
      ) : needs.data.length === 0 ? (
        <p className={styles.empty}>Nothing needs you right now.</p>
      ) : (
        <ul className={styles.list}>
          {needs.data.slice(0, NEEDS_SHOWN).map((n) => {
            const Icon = NEED_ICON[n.source];
            const acts = n.actions.filter((a) => a.kind !== "link");
            const kcls = `${styles.k} ${n.severity === "urgent" ? styles.kHot : n.source === "checklist" ? styles.kTask : ""}`;
            return (
              <li key={n.id}>
                <div className={styles.item}>
                  <span className={kcls}>
                    <Icon className={styles.icon} aria-hidden={true} />
                  </span>
                  <div className={styles.main}>
                    <Link href={n.href} className={styles.ttl}>
                      {n.title}
                    </Link>
                    <span className={`${styles.sub} ${styles.num}`}>{n.context}</span>
                    {acts.length > 0 ? (
                      <div className={styles.acts}>
                        {acts.map((a, i) => (
                          <NeedActionButton
                            key={`${a.kind}-${i}`}
                            action={a}
                            meId={snapshot.user.id}
                            onChanged={() => void refresh()}
                            buttonClassName={styles.actBtn}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TeamPanel({ service, state, title }: { service: NextService | null; state: string; title: string }) {
  const link =
    service && service.source === "planning_center" ? <Link href={service.href}>Planning Center</Link> : null;
  let body;
  if (!service) {
    body = (
      <p className={styles.empty}>
        {state === "unconfigured" ? "Planning Center is not set up yet." : "No upcoming service could be loaded just now."}
      </p>
    );
  } else if (!service.team || service.team.positions.length === 0) {
    body = <p className={styles.empty}>No team is rostered for this service yet.</p>;
  } else {
    body = (
      <dl className={styles.roster}>
        {service.team.positions.map((pos) => (
          <PositionRow key={pos.name} pos={pos} />
        ))}
      </dl>
    );
  }
  return (
    <section className={styles.panel} aria-labelledby="ts-team-h" data-testid="team-panel">
      <h2 id="ts-team-h">
        {title} {link}
      </h2>
      {body}
    </section>
  );
}

function PositionRow({ pos }: { pos: NonNullable<NextService["team"]>["positions"][number] }) {
  return (
    <>
      <dt>{pos.name}</dt>
      <dd>
        {pos.people.map((p, i) => (
          <span key={`${p.name}-${i}`}>
            {i > 0 ? ", " : ""}
            {p.isMe ? (
              <span className={styles.me}>
                {p.name}
                <span className={styles.sr}> (you)</span>
              </span>
            ) : (
              p.name
            )}
            {p.status === "waiting" ? <span className={`${styles.pill} ${styles.pillU}`}>unconfirmed</span> : null}
            {p.status === "declined" ? <span className={`${styles.pill} ${styles.pillD}`}>declined</span> : null}
          </span>
        ))}
      </dd>
    </>
  );
}

const CREATE_LINKS: { module: string; href: string; label: string; Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }> }[] = [
  { module: "tickets", href: "/tickets/new", label: "Ticket", Icon: Ticket },
  { module: "wiki", href: "/wiki/new", label: "Wiki page", Icon: BookOpen },
  { module: "notes", href: "/notes", label: "Note", Icon: FileText },
];

function CreatePanel({
  snapshot,
  me,
  weekStart,
}: {
  snapshot: HomeSnapshot;
  me: LookProps["me"];
  weekStart: string | null;
}) {
  const tz = snapshot.timezone;
  const links = CREATE_LINKS.filter((l) => me.access[l.module] !== undefined);
  const wiki = snapshot.wiki;
  const changed =
    wiki.state === "ok" && weekStart
      ? wiki.data.recent.filter((p) => dateKey(new Date(p.updatedAt), tz) >= weekStart).slice(0, 5)
      : [];
  return (
    <section className={styles.panel} aria-labelledby="ts-create-h" data-testid="create-panel">
      <h2 id="ts-create-h">Create</h2>
      {links.length > 0 ? (
        <div className={styles.create}>
          {links.map(({ href, label, Icon }) => (
            <Link key={href} href={href}>
              <Icon className={styles.icon} aria-hidden={true} />
              {label}
            </Link>
          ))}
        </div>
      ) : null}
      {wiki.state === "forbidden" ? null : (
        <>
          <h3 className={styles.subH}>Changed in the wiki this week</h3>
          {wiki.state !== "ok" ? (
            <p className={styles.empty}>This could not be loaded just now.</p>
          ) : changed.length === 0 ? (
            <p className={styles.empty}>Nothing has changed in the wiki this week.</p>
          ) : (
            <ul className={`${styles.list} ${styles.wiki}`}>
              {changed.map((p) => (
                <li key={p.id}>
                  <Link href={p.href}>
                    <span className={styles.wt}>{p.title}</span>
                    <span className={styles.wm}>
                      {p.updatedByName ? `${p.updatedByName}, ` : ""}
                      {formatWeekdayInZone(new Date(p.updatedAt), tz)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function LowerRow({
  snapshot,
  me,
  refresh,
  service,
  teamTitle,
  weekStart,
}: {
  snapshot: HomeSnapshot;
  me: LookProps["me"];
  refresh: () => Promise<void>;
  service: NextService | null;
  teamTitle: string;
  weekStart: string | null;
}) {
  return (
    <div className={styles.lower}>
      <NeedsPanel snapshot={snapshot} refresh={refresh} />
      {snapshot.service.state === "forbidden" ? null : (
        <TeamPanel service={service} state={snapshot.service.state} title={teamTitle} />
      )}
      <CreatePanel snapshot={snapshot} me={me} weekStart={weekStart} />
    </div>
  );
}
