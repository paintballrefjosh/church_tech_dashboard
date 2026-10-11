import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { PERMISSIONS, TICKET_PRIORITIES, type TicketPriority } from "@church/shared";
import type { Db } from "../../../db/db.module";
import type { AuthenticatedUser } from "../../../auth/current-user.decorator";
import type { SettingsService } from "../../../settings/settings.service";
import {
  checklistEventAssignees,
  checklistEventTasks,
  checklistEvents,
  tickets,
} from "../../../db/schema";
import { asPriority, numberOr } from "../names";

export interface ChecklistEventProgress {
  id: string;
  name: string;
  scheduledAt: Date;
  total: number;
  done: number;
}

function canReadAllChecklists(user: AuthenticatedUser): boolean {
  return (
    user.permissions.includes(PERMISSIONS.CHECKLISTS_READ_ANY) ||
    user.permissions.includes(PERMISSIONS.CHECKLISTS_ADMIN)
  );
}

/**
 * Checklist events scheduled in [from, to) that the person may see (everyone with read-any, else the
 * events they are rostered on), with how many of their tasks are done. Oldest first.
 */
export async function checklistEventsBetween(
  db: Db,
  user: AuthenticatedUser,
  from: Date,
  to: Date,
  order: "asc" | "desc" = "asc",
  limit = 100,
): Promise<ChecklistEventProgress[]> {
  const conds = [gte(checklistEvents.scheduledAt, from), lt(checklistEvents.scheduledAt, to)];
  if (!canReadAllChecklists(user)) {
    conds.push(
      inArray(
        checklistEvents.id,
        db
          .select({ id: checklistEventAssignees.eventId })
          .from(checklistEventAssignees)
          .where(eq(checklistEventAssignees.userId, user.id)),
      ),
    );
  }
  const events = await db
    .select({ id: checklistEvents.id, name: checklistEvents.name, scheduledAt: checklistEvents.scheduledAt })
    .from(checklistEvents)
    .where(and(...conds))
    .orderBy(order === "asc" ? asc(checklistEvents.scheduledAt) : desc(checklistEvents.scheduledAt))
    .limit(limit);
  if (events.length === 0) return [];
  const counts = await db
    .select({
      eventId: checklistEventTasks.eventId,
      total: sql<string>`count(*)`,
      done: sql<string>`count(${checklistEventTasks.completedAt})`,
    })
    .from(checklistEventTasks)
    .where(inArray(checklistEventTasks.eventId, events.map((e) => e.id)))
    .groupBy(checklistEventTasks.eventId);
  const byEvent = new Map(counts.map((c) => [c.eventId, { total: Number(c.total), done: Number(c.done) }]));
  const out: ChecklistEventProgress[] = [];
  for (const e of events) {
    if (!e.scheduledAt) continue;
    const c = byEvent.get(e.id) ?? { total: 0, done: 0 };
    out.push({ id: e.id, name: e.name, scheduledAt: e.scheduledAt, total: c.total, done: c.done });
  }
  return out;
}

/** Response targets in minutes per priority (0 = no target). */
export async function responseTargets(settings: SettingsService): Promise<Record<TicketPriority, number>> {
  const entries = await Promise.all(
    TICKET_PRIORITIES.map(async (p) => [p, numberOr(await settings.get(`tickets.sla.response_min.${p}`), 0)] as const),
  );
  return Object.fromEntries(entries) as Record<TicketPriority, number>;
}

export interface WaitingTicket {
  id: string;
  number: number;
  title: string;
  priority: TicketPriority;
  createdAt: Date;
}

/** Open tickets nobody has answered yet, in the person's scope (their own, or all with read-any). */
export async function unansweredTickets(
  db: Db,
  user: AuthenticatedUser,
  priorities: readonly TicketPriority[] | null,
  limit = 300,
): Promise<WaitingTicket[]> {
  const readAny = user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY);
  const conds = [inArray(tickets.status, ["open", "in_progress"]), isNull(tickets.firstResponseAt)];
  if (!readAny) conds.push(eq(tickets.createdByUserId, user.id));
  if (priorities) conds.push(inArray(tickets.priority, [...priorities]));
  const rows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      title: tickets.title,
      priority: tickets.priority,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(and(...conds))
    .orderBy(desc(tickets.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, number: Number(r.number), priority: asPriority(r.priority) }));
}
