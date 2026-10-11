import { z } from "zod";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "../schemas/ticket";

/** Optional parts of the home snapshot, requested with `?include=week,meters`. */
export const HOME_INCLUDES = ["week", "readiness", "availability", "meters"] as const;
export type HomeInclude = (typeof HOME_INCLUDES)[number];

/** Parses `?include=week,meters`: a comma list; unknown values are rejected. */
export const homeQuerySchema = z.object({
  include: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const out: HomeInclude[] = [];
      for (const raw of (v ?? "").split(",")) {
        const item = raw.trim();
        if (item === "") continue;
        if (!(HOME_INCLUDES as readonly string[]).includes(item)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown include "${item}"` });
          return z.NEVER;
        }
        if (!out.includes(item as HomeInclude)) out.push(item as HomeInclude);
      }
      return out;
    }),
});
export type HomeQuery = z.infer<typeof homeQuerySchema>;

export const SECTION_UNAVAILABLE_STATES = ["unconfigured", "unavailable", "forbidden"] as const;
export type SectionUnavailableState = (typeof SECTION_UNAVAILABLE_STATES)[number];

export type Section<T> =
  | { state: "ok"; data: T }
  | { state: SectionUnavailableState; reason?: string };

export function sectionSchema<S extends z.ZodTypeAny>(data: S) {
  return z.union([
    z.object({ state: z.literal("ok"), data }),
    z.object({ state: z.enum(SECTION_UNAVAILABLE_STATES), reason: z.string().optional() }),
  ]);
}

export function sectionOk<T>(data: T): Section<T> {
  return { state: "ok", data };
}
export function sectionOff<T = never>(state: SectionUnavailableState, reason?: string): Section<T> {
  return reason === undefined ? { state } : { state, reason };
}

export const AREA_KEYS = ["servers", "internet", "wifi", "switches", "dns"] as const;
export type AreaKey = (typeof AREA_KEYS)[number];
const areaKey = z.enum(AREA_KEYS);

const iso = z.string();

export const nextServiceSchema = z.object({
  source: z.enum(["planning_center", "checklist"]),
  title: z.string(),
  seriesTitle: z.string().nullable(),
  serviceTypeName: z.string().nullable(),
  href: z.string(),
  startsAt: iso.nullable(),
  times: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["service", "rehearsal", "other"]),
      name: z.string().nullable(),
      startsAt: iso.nullable(),
      endsAt: iso.nullable(),
    }),
  ),
  team: z
    .object({
      confirmed: z.number(),
      waiting: z.number(),
      declined: z.number(),
      positions: z.array(
        z.object({
          name: z.string(),
          people: z.array(
            z.object({
              name: z.string(),
              status: z.enum(["confirmed", "waiting", "declined"]),
              isMe: z.boolean(),
              localUserId: z.string().nullable(),
            }),
          ),
        }),
      ),
    })
    .nullable(),
});
export type NextService = z.infer<typeof nextServiceSchema>;

export const systemsHealthSchema = z.object({
  areas: z.array(
    z.object({
      key: areaKey,
      label: z.string(),
      href: z.string(),
      state: z.enum(["ok", "unconfigured", "unavailable", "forbidden"]),
      up: z.number(),
      down: z.number(),
      total: z.number(),
      note: z.string().nullable(),
    }),
  ),
  totals: z.object({ up: z.number(), down: z.number(), total: z.number() }),
  problems: z.array(
    z.object({
      id: z.string(),
      area: areaKey,
      name: z.string(),
      detail: z.string().nullable(),
      since: iso.nullable(),
      href: z.string(),
      ack: z.object({ kind: z.literal("unifi"), mac: z.string(), acked: z.boolean() }).nullable(),
    }),
  ),
  maintenanceMode: z.boolean(),
  canWrite: z.boolean(),
});
export type SystemsHealth = z.infer<typeof systemsHealthSchema>;

export const needActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("link"), label: z.string(), href: z.string() }),
  z.object({ kind: z.literal("unifi_ack"), label: z.string(), mac: z.string() }),
  z.object({ kind: z.literal("ticket_take"), label: z.string(), ticketId: z.string() }),
]);
export type NeedAction = z.infer<typeof needActionSchema>;

export const needItemSchema = z.object({
  id: z.string(),
  source: z.enum(["ticket", "system", "team", "checklist"]),
  severity: z.enum(["urgent", "soon", "normal"]),
  group: z.enum(["before_service", "this_week", "later"]),
  title: z.string(),
  context: z.string(),
  href: z.string(),
  dueAt: iso.nullable(),
  actions: z.array(needActionSchema),
});
export type NeedItem = z.infer<typeof needItemSchema>;

export const ticketSummarySchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES),
  requesterName: z.string().nullable(),
  assignedToMe: z.boolean(),
  createdAt: iso,
  responseDueAt: iso.nullable(),
  responseBreached: z.boolean(),
  href: z.string(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const ticketDigestSchema = z.object({
  mine: z.array(ticketSummarySchema),
  unassignedCount: z.number(),
  openCount: z.number(),
  canAssign: z.boolean(),
});
export type TicketDigest = z.infer<typeof ticketDigestSchema>;

export const checklistDigestSchema = z.object({
  events: z.array(
    z.object({
      eventId: z.string(),
      name: z.string(),
      scheduledAt: iso.nullable(),
      href: z.string(),
      tasks: z.array(
        z.object({
          taskId: z.string(),
          title: z.string(),
          positionName: z.string().nullable(),
          done: z.boolean(),
        }),
      ),
    }),
  ),
});
export type ChecklistDigest = z.infer<typeof checklistDigestSchema>;

export const wikiDigestSchema = z.object({
  recent: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      href: z.string(),
      updatedAt: iso,
      updatedByName: z.string().nullable(),
    }),
  ),
});
export type WikiDigest = z.infer<typeof wikiDigestSchema>;

export const notesDigestSchema = z.object({
  count: z.number(),
  recent: z.array(z.object({ id: z.string(), title: z.string(), href: z.string(), updatedAt: iso })),
});
export type NotesDigest = z.infer<typeof notesDigestSchema>;

export const activityItemSchema = z.object({
  id: z.string(),
  at: iso,
  actorName: z.string().nullable(),
  summary: z.string(),
  href: z.string().nullable(),
  kind: z.string(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const weekDigestSchema = z.object({
  weekStart: z.string(),
  today: z.string(),
  days: z.array(
    z.object({
      date: z.string(),
      label: z.string(),
      isToday: z.boolean(),
      isPast: z.boolean(),
      events: z.array(
        z.object({
          kind: z.enum(["incident", "ticket", "checklist", "service", "backup", "wiki"]),
          title: z.string(),
          detail: z.string().nullable(),
          at: iso,
          tone: z.enum(["ok", "warn", "bad", "info"]),
          href: z.string().nullable(),
        }),
      ),
      moreCount: z.number(),
      health: z.array(z.enum(["up", "partial", "down", "none", "future"])),
    }),
  ),
});
export type WeekDigest = z.infer<typeof weekDigestSchema>;

export const readinessSchema = z.object({
  score: z.number(),
  total: z.number(),
  checks: z.array(
    z.object({
      key: z.enum(["systems", "team", "stream", "runthrough", "helpdesk"]),
      label: z.string(),
      ok: z.boolean(),
      detail: z.string(),
      href: z.string().nullable(),
    }),
  ),
});
export type Readiness = z.infer<typeof readinessSchema>;

export const availabilityGridSchema = z.object({
  hours: z.array(iso),
  groups: z.array(
    z.object({
      area: areaKey,
      label: z.string(),
      href: z.string(),
      systems: z.array(
        z.object({
          ref: z.string(),
          name: z.string(),
          href: z.string().nullable(),
          cells: z.array(z.enum(["up", "partial", "down", "none"])),
        }),
      ),
    }),
  ),
});
export type AvailabilityGrid = z.infer<typeof availabilityGridSchema>;

export const systemMetersSchema = z.object({
  channels: z.array(
    z.object({
      area: areaKey,
      level: z.number().nullable(),
      readings: z.array(z.object({ label: z.string(), value: z.string() })),
    }),
  ),
  recentAlerts: z.array(z.object({ at: iso, title: z.string(), href: z.string().nullable() })),
});
export type SystemMeters = z.infer<typeof systemMetersSchema>;

export const homeSnapshotSchema = z.object({
  generatedAt: iso,
  timezone: z.string(),
  dayPart: z.enum(["morning", "afternoon", "evening"]),
  user: z.object({ id: z.string(), firstName: z.string() }),
  site: z.object({ name: z.string(), tagline: z.string() }),
  service: sectionSchema(nextServiceSchema),
  systems: sectionSchema(systemsHealthSchema),
  needs: sectionSchema(z.array(needItemSchema)),
  tickets: sectionSchema(ticketDigestSchema),
  checklists: sectionSchema(checklistDigestSchema),
  wiki: sectionSchema(wikiDigestSchema),
  notes: sectionSchema(notesDigestSchema),
  activity: sectionSchema(z.array(activityItemSchema)),
  week: sectionSchema(weekDigestSchema).optional(),
  readiness: sectionSchema(readinessSchema).optional(),
  availability: sectionSchema(availabilityGridSchema).optional(),
  meters: sectionSchema(systemMetersSchema).optional(),
});

export interface HomeSnapshot {
  generatedAt: string;
  timezone: string;
  dayPart: "morning" | "afternoon" | "evening";
  user: { id: string; firstName: string };
  site: { name: string; tagline: string };
  service: Section<NextService>;
  systems: Section<SystemsHealth>;
  needs: Section<NeedItem[]>;
  tickets: Section<TicketDigest>;
  checklists: Section<ChecklistDigest>;
  wiki: Section<WikiDigest>;
  notes: Section<NotesDigest>;
  activity: Section<ActivityItem[]>;
  week?: Section<WeekDigest>;
  readiness?: Section<Readiness>;
  availability?: Section<AvailabilityGrid>;
  meters?: Section<SystemMeters>;
}
