import { inArray } from "drizzle-orm";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketPriority, type TicketStatus } from "@church/shared";
import type { Db } from "../../db/db.module";
import { users } from "../../db/schema";

/** Display names for a set of user ids (the name, else the part of the email before the @). */
export async function loadUserNames(db: Db, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string" && x !== ""))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, wanted));
  for (const r of rows) out.set(r.id, r.name?.trim() || r.email.split("@")[0] || r.email);
  return out;
}

/** Reads a numeric setting that may arrive as a number or a numeric string. */
export function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Ticket columns are plain text in the database; narrow them to the shared unions. */
export function asPriority(v: string): TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(v) ? (v as TicketPriority) : "normal";
}
export function asStatus(v: string): TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(v) ? (v as TicketStatus) : "open";
}
