import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Checklist module — admins create reusable *templates*; each template is
 * instantiated into a per-date *event* (e.g. "Sunday service — 2026-06-15").
 * Tasks are *snapshot-copied* from template to event on creation so future
 * template edits never retroactively change a completed event's history.
 *
 * Position-based assignment: each template task carries a free-form
 * `position_name` (matches a Planning Center team-position name). On event
 * creation an admin can point at a PC plan; we look up team-members with
 * the matching position, resolve them to local users via
 * planning_center_links, and pre-fill `assigned_user_id`.
 */
/**
 * First-class, admin-managed "stations" (Camera, FOH, ProPresenter, Lights,
 * Stream, …). A template is assigned to one station (below); a day's event then
 * groups by station. `pcAlias` is an optional Planning Center team-position name
 * used to auto-assign people to this station from a linked PC plan.
 */
export const checklistStations = pgTable(
  "checklist_stations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    pcAlias: text("pc_alias"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameUniq: uniqueIndex("checklist_stations_name_uniq").on(t.name),
  }),
);

export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /** The station this template's checklist belongs to (null = "General"). */
    stationId: uuid("station_id").references(() => checklistStations.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("checklist_templates_name_idx").on(t.name),
  }),
);

export const checklistTemplateTasks = pgTable(
  "checklist_template_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /**
     * Optional Planning Center position name. When present, the admin can
     * auto-fill `assigned_user_id` on event creation by matching this name
     * against PC team-members on the chosen plan.
     */
    positionName: text("position_name"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    templateIdx: index("checklist_template_tasks_template_idx").on(t.templateId),
  }),
);

/**
 * Recurring "service" definition (e.g. "Sunday Service"). Materialises into
 * `checklist_events` ahead of time by the ChecklistScheduler. Task lists come
 * from one or more templates (`checklist_service_templates`, below) — a
 * generated occurrence's tasks are the union of every linked template's
 * tasks, concatenated in link order. Positions + default assignees are
 * configured per service (below) so each generated occurrence starts with
 * its stations rostered.
 */
export const checklistServices = pgTable(
  "checklist_services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    /** Only "weekly" is generated today; "none" parks a service without a schedule. */
    recurrenceKind: text("recurrence_kind").notNull().default("weekly"),
    /** 0 = Sunday .. 6 = Saturday (used when recurrenceKind = 'weekly'). */
    weekday: integer("weekday").notNull().default(0),
    /** Local time of day, "HH:MM". */
    timeOfDay: text("time_of_day").notNull().default("09:00"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("checklist_services_name_idx").on(t.name),
  }),
);

/** The templates a service pulls tasks from, in combination order (a
 * generated occurrence's task list is every linked template's tasks,
 * concatenated by `sort_order`). A service must have at least one. */
export const checklistServiceTemplates = pgTable(
  "checklist_service_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => checklistServices.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    serviceIdx: index("checklist_service_templates_service_idx").on(t.serviceId),
    uniq: uniqueIndex("checklist_service_templates_uniq").on(t.serviceId, t.templateId),
  }),
);

/** The stations a service uses. Seeded from the template's distinct positions;
 * an admin can trim to just the ones this service needs. */
export const checklistServicePositions = pgTable(
  "checklist_service_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => checklistServices.id, { onDelete: "cascade" }),
    positionName: text("position_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    serviceIdx: index("checklist_service_positions_service_idx").on(t.serviceId),
    uniq: uniqueIndex("checklist_service_positions_uniq").on(t.serviceId, t.positionName),
  }),
);

/** Default users per service-position (many per position). Copied into a
 * generated event's roster as source='default'. */
export const checklistServicePositionDefaults = pgTable(
  "checklist_service_position_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    servicePositionId: uuid("service_position_id")
      .notNull()
      .references(() => checklistServicePositions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => ({
    positionIdx: index("checklist_service_position_defaults_position_idx").on(t.servicePositionId),
    uniq: uniqueIndex("checklist_service_position_defaults_uniq").on(t.servicePositionId, t.userId),
  }),
);

export const checklistEvents = pgTable(
  "checklist_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id").references(() => checklistTemplates.id, {
      onDelete: "set null",
    }),
    /** Set when this event was generated from a recurring service. */
    serviceId: uuid("service_id").references(() => checklistServices.id, {
      onDelete: "set null",
    }),
    /** The target occurrence date this event represents (for idempotent generation). */
    occurrenceDate: timestamp("occurrence_date"),
    name: text("name").notNull(),
    /** When the event happens (start time). Used for ordering + reminders. */
    scheduledAt: timestamp("scheduled_at"),
    /**
     * Optional Planning Center plan reference — when set the event detail
     * page surfaces a "Sync from PC" button and the auto-assign flow uses
     * this plan to resolve positions.
     */
    pcServiceTypeId: text("pc_service_type_id"),
    pcPlanId: text("pc_plan_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    scheduledIdx: index("checklist_events_scheduled_idx").on(t.scheduledAt),
    // One event per (service, occurrence) so the scheduler stays idempotent.
    occurrenceUniq: uniqueIndex("checklist_events_service_occurrence_uniq").on(
      t.serviceId,
      t.occurrenceDate,
    ),
  }),
);

export const checklistEventTasks = pgTable(
  "checklist_event_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => checklistEvents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /** Station name for this task, snapshot from the source template's station
     * ("General" when the template has none). Roster/tablet/grouping key. */
    positionName: text("position_name"),
    /** Source template name, snapshot for the "templates as children" label. */
    templateName: text("template_name"),
    sortOrder: integer("sort_order").notNull().default(0),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Free-form note left by the completer (optional). */
    note: text("note"),
    completedAt: timestamp("completed_at"),
    completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: index("checklist_event_tasks_event_idx").on(t.eventId),
    assignedIdx: index("checklist_event_tasks_assigned_idx").on(t.assignedUserId),
  }),
);

/**
 * Per-event roster — the source of truth for who is on a station. Many users may
 * be rostered to one position. This replaces the single per-task
 * `assigned_user_id` for gating completion + visibility + "my checklists":
 *  - completion of a position's tasks is allowed for its rostered users (plus
 *    kiosk/admin), so a shared station tablet account rostered to the position
 *    can work its list;
 *  - `source` records how the row got there (a service default, a manual add, or
 *    a Planning Center sync) so Sync-from-Plan can reason about conflicts.
 */
export const checklistEventAssignees = pgTable(
  "checklist_event_assignees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => checklistEvents.id, { onDelete: "cascade" }),
    positionName: text("position_name").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: index("checklist_event_assignees_event_idx").on(t.eventId),
    userIdx: index("checklist_event_assignees_user_idx").on(t.userId),
    uniq: uniqueIndex("checklist_event_assignees_uniq").on(t.eventId, t.positionName, t.userId),
  }),
);
