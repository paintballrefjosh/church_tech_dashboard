"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Plus } from "lucide-react";
import type { HomeSnapshot, NextService } from "@church/shared";
import { RelativeTime } from "../../parts/relative-time";
import type { LookProps } from "../../look-props";
import { dueWhen, eventWhen, useNow } from "./format";
import s from "./front-of-house.module.css";

type Position = NonNullable<NextService["team"]>["positions"][number];

function positionStatus(p: Position): { led: string | undefined; word: string } {
  const n = p.people.length;
  if (n === 0) return { led: s.ledOff, word: "Not filled" };
  const waiting = p.people.filter((x) => x.status === "waiting").length;
  const declined = p.people.filter((x) => x.status === "declined").length;
  if (waiting === 0 && declined === 0) return { led: s.ledG, word: "Confirmed" };
  if (declined === n) return { led: s.ledR, word: "Declined" };
  if (waiting > 0) return { led: s.ledA, word: waiting === n ? "Waiting" : `${waiting} waiting` };
  return { led: s.ledR, word: `${declined} declined` };
}

export function TeamCard({ snapshot }: { snapshot: HomeSnapshot }) {
  if (snapshot.service.state !== "ok" || !snapshot.service.data.team) return null;
  const service = snapshot.service.data;
  const positions = service.team?.positions ?? [];
  return (
    <section className={s.card} aria-labelledby="foh-team">
      <h2 id="foh-team">
        Sunday&apos;s team <Link href={service.href}>Planning Center</Link>
      </h2>
      {positions.length === 0 ? (
        <p className={s.muted}>Nobody is scheduled yet.</p>
      ) : (
        <table className={s.inputs}>
          <thead>
            <tr>
              <th scope="col">Ch</th>
              <th scope="col">Position</th>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody className={s.num}>
            {positions.map((p, i) => {
              const st = positionStatus(p);
              const mine = p.people.some((x) => x.isMe);
              return (
                <tr key={`${p.name}-${i}`} className={mine ? s.me : undefined}>
                  <td className={s.ch}>{String(i + 1).padStart(2, "0")}</td>
                  <td className={s.pos}>{p.name}</td>
                  <td className={s.nm}>
                    {p.people.length === 0 ? "-" : p.people.map((x) => (x.isMe ? "You" : x.name)).join(", ")}
                  </td>
                  <td className={s.st}>
                    <span className={`${s.led} ${st.led}`} aria-hidden />
                    {st.word}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

async function patchTask(taskId: string, completed: boolean): Promise<string | null> {
  try {
    const res = await fetch(`/api/checklists/event-tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed }),
    });
    if (res.ok) return null;
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j.message === "string") return j.message;
    } catch {
      /* not JSON */
    }
    return res.status === 403 ? "you do not have permission" : `the server answered ${res.status}`;
  } catch {
    return "the server could not be reached";
  }
}

export function ChecklistCard({ snapshot, refresh }: { snapshot: HomeSnapshot; refresh: () => Promise<void> }) {
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  if (snapshot.checklists.state === "forbidden") return null;
  const event = snapshot.checklists.state === "ok" ? snapshot.checklists.data.events[0] : undefined;

  async function tick(taskId: string, completed: boolean) {
    setError(null);
    setOverride((o) => ({ ...o, [taskId]: completed }));
    setPending((p) => ({ ...p, [taskId]: true }));
    const failure = await patchTask(taskId, completed);
    if (failure) {
      setOverride((o) => {
        const { [taskId]: _gone, ...rest } = o;
        return rest;
      });
      setError(`Could not save that tick: ${failure}.`);
    } else {
      await refresh();
      setOverride((o) => {
        const { [taskId]: _gone, ...rest } = o;
        return rest;
      });
    }
    setPending((p) => {
      const { [taskId]: _gone, ...rest } = p;
      return rest;
    });
  }

  return (
    <section className={s.card} aria-labelledby="foh-checklist">
      <h2 id="foh-checklist">
        Your checklist <Link href="/checklists">All checklists</Link>
      </h2>
      {!event ? (
        <p className={s.muted}>
          {snapshot.checklists.state === "ok" ? "Nothing on your checklists right now." : "Checklists are unavailable."}
        </p>
      ) : (
        <ChecklistBody
          snapshot={snapshot}
          event={event}
          override={override}
          pending={pending}
          error={error}
          onTick={(id, v) => void tick(id, v)}
        />
      )}
    </section>
  );
}

function ChecklistBody({
  snapshot,
  event,
  override,
  pending,
  error,
  onTick,
}: {
  snapshot: HomeSnapshot;
  event: NonNullable<Extract<HomeSnapshot["checklists"], { state: "ok" }>["data"]["events"][number]>;
  override: Record<string, boolean>;
  pending: Record<string, boolean>;
  error: string | null;
  onTick: (taskId: string, completed: boolean) => void;
}) {
  const done = event.tasks.filter((t) => override[t.taskId] ?? t.done).length;
  const total = event.tasks.length;
  return (
    <>
      <p className={s.evt}>
        <Link href={event.href}>{event.name}</Link>
        {event.scheduledAt ? `, ${eventWhen(new Date(event.scheduledAt), snapshot.timezone)}` : null}
      </p>
      <div className={s.progress} aria-hidden>
        <i style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
      </div>
      <p className={s.progText} role="status">
        {done} of {total} done
      </p>
      {error ? (
        <p className={s.errorLine} role="alert">
          {error}
        </p>
      ) : null}
      <ul className={s.tasks}>
        {event.tasks.map((t) => {
          const checked = override[t.taskId] ?? t.done;
          return (
            <li key={t.taskId}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pending[t.taskId] === true}
                  onChange={(e) => onTick(t.taskId, e.target.checked)}
                />
                <span className={s.box} aria-hidden>
                  <Check strokeWidth={3} />
                </span>
                <span className={s.taskText}>
                  {t.title}
                  {t.positionName ? <span className={s.kindTag}>{t.positionName}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" } as const;

export function HelpDeskCard({ props }: { props: LookProps }) {
  const { snapshot, me, kiosk } = props;
  const now = useNow(snapshot.generatedAt, 60_000);
  const tickets = snapshot.tickets.state === "ok" ? snapshot.tickets.data.mine.slice(0, 4) : null;
  const wiki = snapshot.wiki.state === "ok" ? snapshot.wiki.data.recent.slice(0, 3) : null;
  const canTicket = "tickets" in me.access;
  const canWiki = "wiki" in me.access;
  const canNote = "notes" in me.access;
  if (snapshot.tickets.state === "forbidden" && snapshot.wiki.state === "forbidden" && !canNote) return null;
  return (
    <section className={s.card} aria-labelledby="foh-desk">
      <h2 id="foh-desk">
        Help desk {snapshot.tickets.state !== "forbidden" ? <Link href="/tickets">All tickets</Link> : null}
      </h2>
      {tickets === null ? null : tickets.length === 0 ? (
        <p className={s.muted}>Nothing assigned to you.</p>
      ) : (
        <ul className={s.list}>
          {tickets.map((t) => {
            const due = t.responseDueAt ? new Date(t.responseDueAt) : null;
            return (
              <li key={t.id}>
                <Link href={t.href}>
                  <span className={s.t}>{t.title}</span>
                  <span className={`${s.m} ${s.num}`}>
                    <span className={`${s.prio} ${t.priority === "high" || t.priority === "urgent" ? s.prioHigh : ""}`}>
                      {PRIORITY_LABEL[t.priority]}
                    </span>
                    <span>
                      #{t.number}
                      {t.requesterName ? `, ${t.requesterName}` : ""}
                    </span>
                    {t.responseBreached ? (
                      <span className={s.overdue}>Reply overdue</span>
                    ) : due ? (
                      <span className={s.due}>Reply by {dueWhen(due, now, snapshot.timezone)}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {wiki && wiki.length > 0 ? (
        <div className={s.sec}>
          <h3>Recently in the wiki</h3>
          <ul className={s.list}>
            {wiki.map((w) => (
              <li key={w.id}>
                <Link href={w.href}>
                  <span className={s.t}>{w.title}</span>
                  <span className={s.m}>
                    {w.updatedByName ? `${w.updatedByName}, ` : ""}
                    <RelativeTime at={w.updatedAt} serverNow={snapshot.generatedAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {kiosk || !(canTicket || canWiki || canNote) ? null : (
        <div className={s.quick}>
          {canTicket ? (
            <Link href="/tickets/new">
              <Plus aria-hidden />
              Ticket
            </Link>
          ) : null}
          {canWiki ? (
            <Link href="/wiki/new">
              <Plus aria-hidden />
              Wiki page
            </Link>
          ) : null}
          {canNote ? (
            <Link href="/notes">
              <Plus aria-hidden />
              Note
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}
