import { z } from "zod";

// ---- Stations (first-class, admin-managed) ----

export const checklistStationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  sortOrder: z.number().int(),
  /** Optional Planning Center team-position name for auto-assign matching. */
  pcAlias: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChecklistStation = z.infer<typeof checklistStationSchema>;

export const createStationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  pcAlias: z.string().trim().max(120).nullable().optional(),
});
export type CreateChecklistStationInput = z.infer<typeof createStationSchema>;

export const updateStationSchema = createStationSchema.partial();
export type UpdateChecklistStationInput = z.infer<typeof updateStationSchema>;

// ---- Templates ----

export const checklistTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  /** The station this template's checklist belongs to (null = "General"). */
  stationId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  stationId: z.string().uuid().nullable().optional(),
});
export type CreateChecklistTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = createTemplateSchema.partial();
export type UpdateChecklistTemplateInput = z.infer<typeof updateTemplateSchema>;

export const checklistTemplateTaskSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  positionName: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
});
export type ChecklistTemplateTask = z.infer<typeof checklistTemplateTaskSchema>;

export const createTemplateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  positionName: z.string().trim().min(1).max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateChecklistTemplateTaskInput = z.infer<typeof createTemplateTaskSchema>;

export const updateTemplateTaskSchema = createTemplateTaskSchema.partial();
export type UpdateChecklistTemplateTaskInput = z.infer<typeof updateTemplateTaskSchema>;

// ---- Events ----

export const checklistEventSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid().nullable(),
  name: z.string().min(1).max(200),
  scheduledAt: z.string().datetime().nullable(),
  pcServiceTypeId: z.string().nullable(),
  pcPlanId: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChecklistEvent = z.infer<typeof checklistEventSchema>;

export const createEventSchema = z.object({
  /** Pulls all tasks from the template at creation time (snapshot). */
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  scheduledAt: z.string().datetime().nullable().optional(),
  pcServiceTypeId: z.string().nullable().optional(),
  pcPlanId: z.string().nullable().optional(),
  /** If true and a PC plan is set, auto-assign tasks by matching position_name. */
  autoAssignFromPlan: z.boolean().default(false),
});
export type CreateChecklistEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  pcServiceTypeId: z.string().nullable().optional(),
  pcPlanId: z.string().nullable().optional(),
});
export type UpdateChecklistEventInput = z.infer<typeof updateEventSchema>;

export const checklistEventTaskSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  /** Station name for this task (snapshot; "General" when the template has none). */
  positionName: z.string().nullable(),
  /** Source template name (snapshot), for the "templates as children" label. */
  templateName: z.string().nullable(),
  sortOrder: z.number().int(),
  assignedUserId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  completedByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChecklistEventTask = z.infer<typeof checklistEventTaskSchema>;

export const updateEventTaskSchema = z.object({
  /** Toggle completion. Setting `completed: true` records the calling user + now().
   * Completion is gated by station roster membership (or kiosk/admin), not a
   * per-task assignee — assignment lives in the event roster now. */
  completed: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type UpdateChecklistEventTaskInput = z.infer<typeof updateEventTaskSchema>;

// ---- Per-event roster (station assignees) ----

/** One person rostered to a station (position) in an event. Many per position. */
export const eventAssigneeSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  positionName: z.string(),
  userId: z.string().uuid(),
  source: z.enum(["default", "manual", "pc"]),
  createdAt: z.string().datetime(),
});
export type EventAssignee = z.infer<typeof eventAssigneeSchema>;

/** Add one user to a position's roster. Admins only. */
export const addAssigneeSchema = z.object({
  positionName: z.string().min(1).max(200),
  userId: z.string().uuid(),
});
export type AddAssigneeInput = z.infer<typeof addAssigneeSchema>;

/** A user an admin may assign to a checklist position. */
export const assignableUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
});
export type AssignableUser = z.infer<typeof assignableUserSchema>;

// ---- Recurring services ----

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** One station in a service, with its default roster (user ids). */
export const servicePositionInputSchema = z.object({
  positionName: z.string().trim().min(1).max(200),
  defaultUserIds: z.array(z.string().uuid()).default([]),
});
export type ServicePositionInput = z.infer<typeof servicePositionInputSchema>;

export const createServiceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  /** Tasks are combined from every linked template, in this order. */
  templateIds: z.array(z.string().uuid()).min(1, "Choose at least one template"),
  active: z.boolean().default(true),
  recurrenceKind: z.enum(["weekly", "none"]).default("weekly"),
  weekday: z.number().int().min(0).max(6).default(0),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
    .default("09:00"),
  positions: z.array(servicePositionInputSchema).default([]),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = createServiceSchema.partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

/** A service as returned to the admin UI, with its positions + defaults resolved. */
export const serviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** Ordered — a generated occurrence's tasks are these templates' tasks, concatenated in this order. */
  templateIds: z.array(z.string().uuid()),
  active: z.boolean(),
  recurrenceKind: z.string(),
  weekday: z.number().int(),
  timeOfDay: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  positions: z.array(
    z.object({
      id: z.string().uuid(),
      positionName: z.string(),
      sortOrder: z.number().int(),
      defaultUserIds: z.array(z.string().uuid()),
    }),
  ),
});
export type ChecklistService = z.infer<typeof serviceSchema>;

// ---- Sync from Plan: per-position conflict diff ----

/** One position's current-vs-planned rosters when reconciling with a PC plan. */
export const planDiffPositionSchema = z.object({
  positionName: z.string(),
  current: z.array(assignableUserSchema),
  planned: z.array(assignableUserSchema),
  differs: z.boolean(),
});
export const planDiffSchema = z.object({
  reachable: z.boolean(),
  error: z.string().nullable(),
  positions: z.array(planDiffPositionSchema),
});
export type PlanDiff = z.infer<typeof planDiffSchema>;

/** Apply the admin's per-position choice from the conflict chooser. */
export const applyPlanSchema = z.object({
  positions: z.array(
    z.object({
      positionName: z.string().min(1).max(200),
      use: z.enum(["plan", "current"]),
    }),
  ),
});
export type ApplyPlanInput = z.infer<typeof applyPlanSchema>;

// ---- Reports ----

export const checklistEventStatsSchema = z.object({
  eventId: z.string().uuid(),
  total: z.number().int(),
  completed: z.number().int(),
  assigned: z.number().int(),
  pctComplete: z.number(),
});
export type ChecklistEventStats = z.infer<typeof checklistEventStatsSchema>;
