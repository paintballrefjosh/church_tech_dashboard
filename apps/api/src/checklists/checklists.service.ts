import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, isNull, inArray, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  checklistTemplates,
  checklistTemplateTasks,
  checklistEvents,
  checklistEventTasks,
  checklistEventAssignees,
  checklistServices,
  checklistServiceTemplates,
  checklistServicePositions,
  checklistServicePositionDefaults,
  checklistStations,
  planningCenterLinks,
  users,
} from "../db/schema";
import {
  PERMISSIONS,
  type CreateChecklistTemplateInput,
  type UpdateChecklistTemplateInput,
  type CreateChecklistTemplateTaskInput,
  type UpdateChecklistTemplateTaskInput,
  type CreateChecklistEventInput,
  type UpdateChecklistEventInput,
  type UpdateChecklistEventTaskInput,
  type AddAssigneeInput,
  type CreateServiceInput,
  type UpdateServiceInput,
  type ApplyPlanInput,
  type PlanDiff,
  type AssignableUser,
  type ServicePositionInput,
  type CreateChecklistStationInput,
  type UpdateChecklistStationInput,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { NotificationsService } from "../notifications/notifications.service";
import { PlanningCenterService } from "../planning-center/planning-center.service";

/** Roster/station key for a task's position. A task with no position joins the
 * "Other" station, matching how the UI groups it — the roster column is NOT
 * NULL, so this is the single normalization used for every roster read/write. */
export function posKey(positionName: string | null | undefined): string {
  return positionName && positionName.trim() ? positionName : "General";
}

/** How far ahead the scheduler materialises recurring occurrences (8 weeks). */
const RECURRENCE_HORIZON_DAYS = 56;

@Injectable()
export class ChecklistsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly pc: PlanningCenterService,
  ) {}

  // ---- shared helpers ----

  private canAdmin(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.CHECKLISTS_ADMIN);
  }
  private canReadAny(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.CHECKLISTS_READ_ANY) || this.canAdmin(user);
  }
  /** Kiosk capability: complete any station's tasks regardless of roster. */
  private canCompleteAny(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.CHECKLISTS_COMPLETE_ANY) || this.canAdmin(user);
  }

  /** All roster rows for an event. */
  private eventRoster(eventId: string) {
    return this.db
      .select()
      .from(checklistEventAssignees)
      .where(eq(checklistEventAssignees.eventId, eventId))
      .orderBy(asc(checklistEventAssignees.positionName), asc(checklistEventAssignees.createdAt));
  }

  /** Is this user rostered to a given (event, position)? */
  private async isRostered(userId: string, eventId: string, position: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: checklistEventAssignees.id })
      .from(checklistEventAssignees)
      .where(
        and(
          eq(checklistEventAssignees.eventId, eventId),
          eq(checklistEventAssignees.positionName, position),
          eq(checklistEventAssignees.userId, userId),
        ),
      )
      .limit(1);
    return !!row;
  }

  // ---- Stations (first-class catalogue) ----

  listStations() {
    return this.db
      .select()
      .from(checklistStations)
      .orderBy(asc(checklistStations.sortOrder), asc(checklistStations.name));
  }

  async createStation(user: AuthenticatedUser, input: CreateChecklistStationInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [maxRow] = await this.db
        .select({ max: sql<number>`coalesce(max(${checklistStations.sortOrder}), -1)` })
        .from(checklistStations);
      sortOrder = Number(maxRow?.max ?? -1) + 1;
    }
    const [row] = await this.db
      .insert(checklistStations)
      .values({ name: input.name, sortOrder, pcAlias: input.pcAlias ?? null })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async updateStation(user: AuthenticatedUser, id: string, input: UpdateChecklistStationInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const patch: Partial<typeof checklistStations.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.pcAlias !== undefined) patch.pcAlias = input.pcAlias ?? null;
    const [row] = await this.db
      .update(checklistStations)
      .set(patch)
      .where(eq(checklistStations.id, id))
      .returning();
    if (!row) throw new NotFoundException("Station not found");
    return row;
  }

  async deleteStation(user: AuthenticatedUser, id: string) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    // Templates' station_id is set null by the FK; existing events keep their
    // snapshot station names.
    await this.db.delete(checklistStations).where(eq(checklistStations.id, id));
    return { ok: true };
  }

  /** Resolve a template's station name (null station → "General"). */
  private async templateStationName(templateId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: checklistStations.name })
      .from(checklistTemplates)
      .leftJoin(checklistStations, eq(checklistStations.id, checklistTemplates.stationId))
      .where(eq(checklistTemplates.id, templateId))
      .limit(1);
    return posKey(row?.name ?? null);
  }

  // ---- Templates ----

  async listTemplates() {
    const rows = await this.db
      .select({
        id: checklistTemplates.id,
        name: checklistTemplates.name,
        description: checklistTemplates.description,
        stationId: checklistTemplates.stationId,
        createdByUserId: checklistTemplates.createdByUserId,
        createdAt: checklistTemplates.createdAt,
        updatedAt: checklistTemplates.updatedAt,
        taskCount: sql<number>`count(${checklistTemplateTasks.id})::int`,
      })
      .from(checklistTemplates)
      .leftJoin(checklistTemplateTasks, eq(checklistTemplateTasks.templateId, checklistTemplates.id))
      .groupBy(checklistTemplates.id)
      .orderBy(asc(checklistTemplates.name));
    return rows.map((r) => ({ ...r, taskCount: Number(r.taskCount) }));
  }

  async getTemplate(id: string) {
    const [row] = await this.db
      .select()
      .from(checklistTemplates)
      .where(eq(checklistTemplates.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }

  templateTasks(templateId: string) {
    return this.db
      .select()
      .from(checklistTemplateTasks)
      .where(eq(checklistTemplateTasks.templateId, templateId))
      .orderBy(asc(checklistTemplateTasks.sortOrder), asc(checklistTemplateTasks.createdAt));
  }

  async createTemplate(user: AuthenticatedUser, input: CreateChecklistTemplateInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [row] = await this.db
      .insert(checklistTemplates)
      .values({
        name: input.name,
        description: input.description ?? null,
        stationId: input.stationId ?? null,
        createdByUserId: user.id,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async updateTemplate(user: AuthenticatedUser, id: string, input: UpdateChecklistTemplateInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.getTemplate(id);
    const patch: Partial<typeof checklistTemplates.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.stationId !== undefined) patch.stationId = input.stationId ?? null;
    const [row] = await this.db
      .update(checklistTemplates)
      .set(patch)
      .where(eq(checklistTemplates.id, id))
      .returning();
    return row!;
  }

  async deleteTemplate(user: AuthenticatedUser, id: string) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.getTemplate(id);
    await this.db.delete(checklistTemplates).where(eq(checklistTemplates.id, id));
    return { ok: true };
  }

  async addTemplateTask(
    user: AuthenticatedUser,
    templateId: string,
    input: CreateChecklistTemplateTaskInput,
  ) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.getTemplate(templateId);
    // Default sortOrder: max + 1 so new tasks land at the bottom.
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [maxRow] = await this.db
        .select({ max: sql<number>`coalesce(max(${checklistTemplateTasks.sortOrder}), -1)` })
        .from(checklistTemplateTasks)
        .where(eq(checklistTemplateTasks.templateId, templateId));
      sortOrder = (Number(maxRow?.max ?? -1)) + 1;
    }
    const [row] = await this.db
      .insert(checklistTemplateTasks)
      .values({
        templateId,
        title: input.title,
        description: input.description ?? null,
        positionName: input.positionName ?? null,
        sortOrder,
      })
      .returning();
    return row!;
  }

  async updateTemplateTask(
    user: AuthenticatedUser,
    taskId: string,
    input: UpdateChecklistTemplateTaskInput,
  ) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [existing] = await this.db
      .select()
      .from(checklistTemplateTasks)
      .where(eq(checklistTemplateTasks.id, taskId))
      .limit(1);
    if (!existing) throw new NotFoundException("Task not found");
    const patch: Partial<typeof checklistTemplateTasks.$inferInsert> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.positionName !== undefined) patch.positionName = input.positionName;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    const [row] = await this.db
      .update(checklistTemplateTasks)
      .set(patch)
      .where(eq(checklistTemplateTasks.id, taskId))
      .returning();
    return row!;
  }

  async deleteTemplateTask(user: AuthenticatedUser, taskId: string) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.db.delete(checklistTemplateTasks).where(eq(checklistTemplateTasks.id, taskId));
    return { ok: true };
  }

  // ---- Events ----

  /**
   * List events the user can see. Admins + checklists:read:any see all;
   * everyone else sees only events with at least one task assigned to them.
   */
  async listEvents(user: AuthenticatedUser, opts: { upcomingOnly?: boolean } = {}) {
    if (this.canReadAny(user)) {
      const conds = [];
      if (opts.upcomingOnly) {
        conds.push(
          sql`(${checklistEvents.scheduledAt} IS NULL OR ${checklistEvents.scheduledAt} >= now() - interval '1 day')`,
        );
      }
      return this.db
        .select()
        .from(checklistEvents)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(checklistEvents.scheduledAt), asc(checklistEvents.createdAt));
    }
    // Restricted view: only events this user is rostered on (any station).
    const rows = await this.db
      .selectDistinct({
        id: checklistEvents.id,
        templateId: checklistEvents.templateId,
        serviceId: checklistEvents.serviceId,
        occurrenceDate: checklistEvents.occurrenceDate,
        name: checklistEvents.name,
        scheduledAt: checklistEvents.scheduledAt,
        pcServiceTypeId: checklistEvents.pcServiceTypeId,
        pcPlanId: checklistEvents.pcPlanId,
        createdByUserId: checklistEvents.createdByUserId,
        createdAt: checklistEvents.createdAt,
        updatedAt: checklistEvents.updatedAt,
      })
      .from(checklistEvents)
      .innerJoin(checklistEventAssignees, eq(checklistEventAssignees.eventId, checklistEvents.id))
      .where(eq(checklistEventAssignees.userId, user.id))
      .orderBy(asc(checklistEvents.scheduledAt), asc(checklistEvents.createdAt));
    if (opts.upcomingOnly) {
      const cutoff = new Date(Date.now() - 86_400_000);
      return rows.filter((r) => !r.scheduledAt || r.scheduledAt >= cutoff);
    }
    return rows;
  }

  async getEvent(user: AuthenticatedUser, id: string) {
    const [event] = await this.db
      .select()
      .from(checklistEvents)
      .where(eq(checklistEvents.id, id))
      .limit(1);
    if (!event) throw new NotFoundException("Event not found");
    if (!this.canReadAny(user)) {
      // Verify the user is rostered on at least one station in this event.
      const [mine] = await this.db
        .select({ id: checklistEventAssignees.id })
        .from(checklistEventAssignees)
        .where(
          and(
            eq(checklistEventAssignees.eventId, id),
            eq(checklistEventAssignees.userId, user.id),
          ),
        )
        .limit(1);
      if (!mine) throw new NotFoundException("Event not found");
    }
    const tasks = await this.db
      .select()
      .from(checklistEventTasks)
      .where(eq(checklistEventTasks.eventId, id))
      .orderBy(asc(checklistEventTasks.sortOrder), asc(checklistEventTasks.createdAt));
    const roster = await this.eventRoster(id);
    return { event, tasks, roster };
  }

  /**
   * Snapshot template tasks onto a new event. If `autoAssignFromPlan` is
   * true and a PC plan id is set, resolve PC team-members by position name
   * → linked local user, and pre-fill `assignedUserId`. Notifies each
   * resolved assignee via the notifications service.
   */
  async createEvent(user: AuthenticatedUser, input: CreateChecklistEventInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.getTemplate(input.templateId);
    const tasks = await this.templateTasks(input.templateId);
    // A manual event uses one template = one station.
    const [tinfo] = await this.db
      .select({
        name: checklistTemplates.name,
        stationName: checklistStations.name,
        pcAlias: checklistStations.pcAlias,
      })
      .from(checklistTemplates)
      .leftJoin(checklistStations, eq(checklistStations.id, checklistTemplates.stationId))
      .where(eq(checklistTemplates.id, input.templateId))
      .limit(1);
    const stationName = posKey(tinfo?.stationName ?? null);
    const templateName = tinfo?.name ?? null;

    // Resolve PC people for this station (matched by station name or PC alias).
    const rosterByPosition = new Map<string, Set<string>>();
    if (input.autoAssignFromPlan && input.pcServiceTypeId && input.pcPlanId) {
      try {
        const detail = await this.pc.planDetail(input.pcServiceTypeId, input.pcPlanId);
        const aliases = new Set(
          [stationName, tinfo?.pcAlias ?? ""].map((s) => s.trim().toLowerCase()).filter(Boolean),
        );
        const people = new Set<string>();
        for (const a of detail.assignments) {
          if (a.localUserId && aliases.has(a.positionName.trim().toLowerCase())) people.add(a.localUserId);
        }
        if (people.size) rosterByPosition.set(stationName, people);
      } catch {
        /* PC unreachable — event is created with an empty roster */
      }
    }

    const [event] = await this.db
      .insert(checklistEvents)
      .values({
        templateId: input.templateId,
        name: input.name,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        pcServiceTypeId: input.pcServiceTypeId ?? null,
        pcPlanId: input.pcPlanId ?? null,
        createdByUserId: user.id,
      })
      .returning();
    if (!event) throw new Error("Insert failed");

    const inserted: (typeof checklistEventTasks.$inferSelect)[] = [];
    if (tasks.length > 0) {
      const rows = tasks.map((t) => ({
        eventId: event.id,
        title: t.title,
        description: t.description,
        positionName: stationName,
        templateName,
        sortOrder: t.sortOrder,
      }));
      const out = await this.db.insert(checklistEventTasks).values(rows).returning();
      inserted.push(...out);
    }

    await this.seedRoster(event.id, rosterByPosition, "pc");

    // Notify each PC-resolved assignee once.
    const assigneeIds = new Set([...rosterByPosition.values()].flatMap((s) => [...s]));
    for (const uid of assigneeIds) {
      if (uid === user.id) continue;
      void this.notifications.create({
        recipientUserId: uid,
        kind: "checklist.assigned",
        title: `New checklist: ${event.name}`,
        body: `You have tasks to complete for "${event.name}".`,
        link: `/checklists/${event.id}`,
        excludeActorId: user.id,
      });
    }

    return { event, tasks: inserted, roster: await this.eventRoster(event.id) };
  }

  /** Insert roster rows for an event from a position→userIds map (dedup-safe). */
  private async seedRoster(
    eventId: string,
    byPosition: Map<string, Set<string>>,
    source: "default" | "manual" | "pc",
  ): Promise<void> {
    const rows: (typeof checklistEventAssignees.$inferInsert)[] = [];
    for (const [positionName, userIds] of byPosition) {
      for (const userId of userIds) rows.push({ eventId, positionName, userId, source });
    }
    if (rows.length) {
      await this.db.insert(checklistEventAssignees).values(rows).onConflictDoNothing();
    }
  }

  async updateEvent(user: AuthenticatedUser, id: string, input: UpdateChecklistEventInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [existing] = await this.db
      .select()
      .from(checklistEvents)
      .where(eq(checklistEvents.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException("Event not found");
    const patch: Partial<typeof checklistEvents.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.scheduledAt !== undefined) {
      patch.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    }
    if (input.pcServiceTypeId !== undefined) patch.pcServiceTypeId = input.pcServiceTypeId;
    if (input.pcPlanId !== undefined) patch.pcPlanId = input.pcPlanId;
    const [row] = await this.db
      .update(checklistEvents)
      .set(patch)
      .where(eq(checklistEvents.id, id))
      .returning();
    return row!;
  }

  async deleteEvent(user: AuthenticatedUser, id: string) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.db.delete(checklistEvents).where(eq(checklistEvents.id, id));
    return { ok: true };
  }

  /**
   * Update an event task: flip `completed` + set `note`. Completion is gated by
   * station roster membership — a user may tick a task if they are rostered to
   * its station, or hold the kiosk permission (shared tablet accounts), or are
   * an admin. Assignment itself lives in the roster, not here.
   */
  async updateEventTask(
    user: AuthenticatedUser,
    taskId: string,
    input: UpdateChecklistEventTaskInput,
  ) {
    const [existing] = await this.db
      .select()
      .from(checklistEventTasks)
      .where(eq(checklistEventTasks.id, taskId))
      .limit(1);
    if (!existing) throw new NotFoundException("Task not found");

    const allowed =
      this.canCompleteAny(user) ||
      (await this.isRostered(user.id, existing.eventId, posKey(existing.positionName)));
    if (!allowed) {
      throw new ForbiddenException("You can only work stations you're rostered to");
    }

    const patch: Partial<typeof checklistEventTasks.$inferInsert> = { updatedAt: new Date() };
    if (input.note !== undefined) patch.note = input.note;
    if (input.completed !== undefined) {
      if (input.completed) {
        patch.completedAt = new Date();
        patch.completedByUserId = user.id;
      } else {
        patch.completedAt = null;
        patch.completedByUserId = null;
      }
    }
    const [row] = await this.db
      .update(checklistEventTasks)
      .set(patch)
      .where(eq(checklistEventTasks.id, taskId))
      .returning();

    return row!;
  }

  /** Active local users an admin can assign to a position. Own endpoint so it's
   * gated on checklists:admin — a checklists admin needn't also hold
   * users:read:any (which the general /users list requires). */
  async assignableUsers(user: AuthenticatedUser) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.isActive, true), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email));
  }

  // ---- Roster (station assignees) ----

  /** Add one user to a position's roster (source 'manual'). Notifies them. */
  async addAssignee(user: AuthenticatedUser, eventId: string, input: AddAssigneeInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [event] = await this.db
      .select({ id: checklistEvents.id, name: checklistEvents.name })
      .from(checklistEvents)
      .where(eq(checklistEvents.id, eventId))
      .limit(1);
    if (!event) throw new NotFoundException("Event not found");
    const position = posKey(input.positionName);
    await this.db
      .insert(checklistEventAssignees)
      .values({ eventId, positionName: position, userId: input.userId, source: "manual" })
      .onConflictDoNothing();
    if (input.userId !== user.id) {
      void this.notifications.create({
        recipientUserId: input.userId,
        kind: "checklist.assigned",
        title: `Assigned: ${position} — ${event.name}`,
        body: `You're on ${position} for "${event.name}".`,
        link: `/checklists/${event.id}`,
        excludeActorId: user.id,
      });
    }
    return this.eventRoster(eventId);
  }

  /** Remove one roster row by id (scoped to the event). */
  async removeAssignee(user: AuthenticatedUser, eventId: string, assigneeId: string) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    await this.db
      .delete(checklistEventAssignees)
      .where(
        and(
          eq(checklistEventAssignees.id, assigneeId),
          eq(checklistEventAssignees.eventId, eventId),
        ),
      );
    return this.eventRoster(eventId);
  }

  /** id -> {id,name,email} for a set of user ids. */
  private async usersById(ids: string[]): Promise<Map<string, AssignableUser>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  // ---- Sync from Plan (per-position conflict diff) ----

  /** The PC plan's roster (posKey -> Set<userId>) for an event's linked plan. */
  private async plannedRoster(
    pcServiceTypeId: string,
    pcPlanId: string,
  ): Promise<Map<string, Set<string>>> {
    const planned = new Map<string, Set<string>>();
    const detail = await this.pc.planDetail(pcServiceTypeId, pcPlanId);
    for (const a of detail.assignments) {
      if (!a.localUserId) continue;
      const key = posKey(a.positionName);
      (planned.get(key) ?? planned.set(key, new Set()).get(key)!).add(a.localUserId);
    }
    return planned;
  }

  /** Compare, per station, the current roster with what the linked PC plan would
   * roster — so an admin can choose which to keep. Never mutates; degrades to
   * `reachable:false` when there is no plan or PC is unreachable. */
  async planDiff(user: AuthenticatedUser, eventId: string): Promise<PlanDiff> {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [event] = await this.db
      .select()
      .from(checklistEvents)
      .where(eq(checklistEvents.id, eventId))
      .limit(1);
    if (!event) throw new NotFoundException("Event not found");
    if (!event.pcServiceTypeId || !event.pcPlanId) {
      return { reachable: false, error: "This event has no Planning Center plan linked.", positions: [] };
    }
    let planned: Map<string, Set<string>>;
    try {
      planned = await this.plannedRoster(event.pcServiceTypeId, event.pcPlanId);
    } catch (err) {
      return { reachable: false, error: (err as Error).message, positions: [] };
    }
    const roster = await this.eventRoster(eventId);
    const current = new Map<string, Set<string>>();
    for (const r of roster) {
      (current.get(r.positionName) ?? current.set(r.positionName, new Set()).get(r.positionName)!).add(r.userId);
    }
    const taskPositions = await this.db
      .selectDistinct({ positionName: checklistEventTasks.positionName })
      .from(checklistEventTasks)
      .where(eq(checklistEventTasks.eventId, eventId));
    const keys = new Set<string>([
      ...taskPositions.map((t) => posKey(t.positionName)),
      ...current.keys(),
      ...planned.keys(),
    ]);
    const userMap = await this.usersById([
      ...new Set([...current.values(), ...planned.values()].flatMap((s) => [...s])),
    ]);
    const positions = [...keys].sort().map((positionName) => {
      const cur = [...(current.get(positionName) ?? [])];
      const plan = [...(planned.get(positionName) ?? [])];
      const differs =
        cur.length !== plan.length ||
        cur.some((u) => !plan.includes(u)) ||
        plan.some((u) => !cur.includes(u));
      return {
        positionName,
        current: cur.map((id) => userMap.get(id)).filter((u): u is AssignableUser => !!u),
        planned: plan.map((id) => userMap.get(id)).filter((u): u is AssignableUser => !!u),
        differs,
      };
    });
    return { reachable: true, error: null, positions };
  }

  /** Apply the admin's per-position choice: positions marked 'plan' have their
   * roster replaced with the PC plan's people (source 'pc'); 'current' is left. */
  async applyPlan(user: AuthenticatedUser, eventId: string, input: ApplyPlanInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [event] = await this.db
      .select()
      .from(checklistEvents)
      .where(eq(checklistEvents.id, eventId))
      .limit(1);
    if (!event) throw new NotFoundException("Event not found");
    if (!event.pcServiceTypeId || !event.pcPlanId) {
      throw new BadRequestException("Event has no Planning Center plan linked");
    }
    const planned = await this.plannedRoster(event.pcServiceTypeId, event.pcPlanId);
    for (const p of input.positions) {
      if (p.use !== "plan") continue;
      const position = posKey(p.positionName);
      await this.db
        .delete(checklistEventAssignees)
        .where(
          and(
            eq(checklistEventAssignees.eventId, eventId),
            eq(checklistEventAssignees.positionName, position),
          ),
        );
      const ids = [...(planned.get(position) ?? [])];
      if (ids.length) {
        await this.db
          .insert(checklistEventAssignees)
          .values(ids.map((userId) => ({ eventId, positionName: position, userId, source: "pc" as const })))
          .onConflictDoNothing();
        for (const uid of ids) {
          if (uid === user.id) continue;
          void this.notifications.create({
            recipientUserId: uid,
            kind: "checklist.assigned",
            title: `Assigned: ${position} — ${event.name}`,
            body: `You're on ${position} for "${event.name}".`,
            link: `/checklists/${event.id}`,
            excludeActorId: user.id,
          });
        }
      }
    }
    return this.eventRoster(eventId);
  }

  // ---- Reports ----

  /**
   * Per-event completion stats over the last `limitEvents` events (default
   * 50, ordered by scheduled_at desc with nulls last). Admin/read:any only.
   */
  async eventStats(user: AuthenticatedUser, limit = 50) {
    if (!this.canReadAny(user)) throw new ForbiddenException("Missing checklists:read:any");
    const rows = await this.db
      .select({
        eventId: checklistEvents.id,
        eventName: checklistEvents.name,
        scheduledAt: checklistEvents.scheduledAt,
        total: sql<number>`count(${checklistEventTasks.id})`,
        completed: sql<number>`count(${checklistEventTasks.completedAt})`,
      })
      .from(checklistEvents)
      .leftJoin(checklistEventTasks, eq(checklistEventTasks.eventId, checklistEvents.id))
      .groupBy(checklistEvents.id, checklistEvents.name, checklistEvents.scheduledAt)
      .orderBy(desc(checklistEvents.scheduledAt))
      .limit(Math.max(1, Math.min(200, limit)));
    // "assigned" is now the number of distinct people rostered on each event.
    const eventIds = rows.map((r) => r.eventId);
    const rosterCounts = eventIds.length
      ? await this.db
          .select({
            eventId: checklistEventAssignees.eventId,
            n: sql<number>`count(distinct ${checklistEventAssignees.userId})`,
          })
          .from(checklistEventAssignees)
          .where(inArray(checklistEventAssignees.eventId, eventIds))
          .groupBy(checklistEventAssignees.eventId)
      : [];
    const rosterMap = new Map(rosterCounts.map((r) => [r.eventId, Number(r.n ?? 0)]));
    return rows.map((r) => {
      const total = Number(r.total ?? 0);
      const completed = Number(r.completed ?? 0);
      return {
        eventId: r.eventId,
        eventName: r.eventName,
        scheduledAt: r.scheduledAt,
        total,
        completed,
        assigned: rosterMap.get(r.eventId) ?? 0,
        pctComplete: total > 0 ? Math.round((100 * completed) / total) : 0,
      };
    });
  }

  /**
   * Per-volunteer stats over the same window. Counts tasks assigned to the
   * user and how many they completed (themselves OR were marked done by
   * someone else — defensive against admins ticking on a volunteer's behalf).
   */
  async volunteerStats(user: AuthenticatedUser, limit = 100) {
    if (!this.canReadAny(user)) throw new ForbiddenException("Missing checklists:read:any");
    // Tasks in the stations each user is rostered on, and how many are done.
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        assigned: sql<number>`count(${checklistEventTasks.id})`,
        completed: sql<number>`count(${checklistEventTasks.completedAt})`,
      })
      .from(checklistEventAssignees)
      .innerJoin(users, eq(users.id, checklistEventAssignees.userId))
      .innerJoin(
        checklistEventTasks,
        and(
          eq(checklistEventTasks.eventId, checklistEventAssignees.eventId),
          eq(
            checklistEventAssignees.positionName,
            sql`coalesce(nullif(trim(${checklistEventTasks.positionName}), ''), 'Other')`,
          ),
        ),
      )
      .groupBy(users.id, users.email, users.name)
      .orderBy(desc(sql`count(${checklistEventTasks.id})`))
      .limit(Math.max(1, Math.min(500, limit)));
    return rows.map((r) => {
      const assigned = Number(r.assigned ?? 0);
      const completed = Number(r.completed ?? 0);
      return {
        userId: r.userId,
        email: r.email,
        name: r.name,
        assigned,
        completed,
        pctComplete: assigned > 0 ? Math.round((100 * completed) / assigned) : 0,
      };
    });
  }

  /**
   * Tasks open for the calling user across all events. Drives the dashboard
   * tile + a /me-style filter view.
   */
  async myOpenTasks(user: AuthenticatedUser) {
    // Open tasks in any station the user is rostered on. The join matches the
    // task's normalized station key against the roster's position_name. A task
    // maps to exactly one roster row per user, so no DISTINCT is needed (and it
    // would clash with ordering by sortOrder, which isn't in the select list).
    return this.db
      .select({
        taskId: checklistEventTasks.id,
        eventId: checklistEventTasks.eventId,
        title: checklistEventTasks.title,
        positionName: checklistEventTasks.positionName,
        eventName: checklistEvents.name,
        scheduledAt: checklistEvents.scheduledAt,
      })
      .from(checklistEventTasks)
      .innerJoin(checklistEvents, eq(checklistEvents.id, checklistEventTasks.eventId))
      .innerJoin(
        checklistEventAssignees,
        and(
          eq(checklistEventAssignees.eventId, checklistEventTasks.eventId),
          eq(
            checklistEventAssignees.positionName,
            sql`coalesce(nullif(trim(${checklistEventTasks.positionName}), ''), 'Other')`,
          ),
          eq(checklistEventAssignees.userId, user.id),
        ),
      )
      .where(isNull(checklistEventTasks.completedAt))
      .orderBy(asc(checklistEvents.scheduledAt), asc(checklistEventTasks.sortOrder));
  }

  // ---- Recurring services ----

  private async serviceWithPositions(id: string) {
    const [svc] = await this.db
      .select()
      .from(checklistServices)
      .where(eq(checklistServices.id, id))
      .limit(1);
    if (!svc) throw new NotFoundException("Service not found");
    const templateLinks = await this.db
      .select({ templateId: checklistServiceTemplates.templateId })
      .from(checklistServiceTemplates)
      .where(eq(checklistServiceTemplates.serviceId, id))
      .orderBy(asc(checklistServiceTemplates.sortOrder));
    const positions = await this.db
      .select()
      .from(checklistServicePositions)
      .where(eq(checklistServicePositions.serviceId, id))
      .orderBy(asc(checklistServicePositions.sortOrder), asc(checklistServicePositions.positionName));
    const defaults = positions.length
      ? await this.db
          .select()
          .from(checklistServicePositionDefaults)
          .where(
            inArray(
              checklistServicePositionDefaults.servicePositionId,
              positions.map((p) => p.id),
            ),
          )
      : [];
    return {
      ...svc,
      templateIds: templateLinks.map((t) => t.templateId),
      positions: positions.map((p) => ({
        id: p.id,
        positionName: p.positionName,
        sortOrder: p.sortOrder,
        defaultUserIds: defaults.filter((d) => d.servicePositionId === p.id).map((d) => d.userId),
      })),
    };
  }

  listServices(user: AuthenticatedUser) {
    if (!this.canReadAny(user)) throw new ForbiddenException("Missing checklists:read:any");
    return this.db.select().from(checklistServices).orderBy(asc(checklistServices.name));
  }

  async getService(user: AuthenticatedUser, id: string) {
    if (!this.canReadAny(user)) throw new ForbiddenException("Missing checklists:read:any");
    return this.serviceWithPositions(id);
  }

  /** The station name a template belongs to — offered when building a service. */
  async templatePositions(user: AuthenticatedUser, templateId: string): Promise<string[]> {
    return this.templatePositionsForMany(user, [templateId]);
  }

  /** Station names of the given templates (each template = one station), offered
   * when building a service. Null-station templates contribute "General". */
  async templatePositionsForMany(user: AuthenticatedUser, templateIds: string[]): Promise<string[]> {
    if (!this.canReadAny(user)) throw new ForbiddenException("Missing checklists:read:any");
    if (!templateIds.length) return [];
    const rows = await this.db
      .select({ name: checklistStations.name })
      .from(checklistTemplates)
      .leftJoin(checklistStations, eq(checklistStations.id, checklistTemplates.stationId))
      .where(inArray(checklistTemplates.id, templateIds));
    return [...new Set(rows.map((r) => posKey(r.name)))].sort();
  }

  private async writeServiceTemplates(serviceId: string, templateIds: string[]) {
    const ids = [...new Set(templateIds)];
    if (!ids.length) return;
    await this.db
      .insert(checklistServiceTemplates)
      .values(ids.map((templateId, i) => ({ serviceId, templateId, sortOrder: i })))
      .onConflictDoNothing();
  }

  async createService(user: AuthenticatedUser, input: CreateServiceInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const templateIds = [...new Set(input.templateIds)];
    for (const templateId of templateIds) await this.getTemplate(templateId);
    const [svc] = await this.db
      .insert(checklistServices)
      .values({
        name: input.name,
        description: input.description ?? null,
        active: input.active,
        recurrenceKind: input.recurrenceKind,
        weekday: input.weekday,
        timeOfDay: input.timeOfDay,
        createdByUserId: user.id,
      })
      .returning();
    if (!svc) throw new Error("Insert failed");
    await this.writeServiceTemplates(svc.id, templateIds);
    await this.writeServicePositions(svc.id, input.positions);
    void this.generateOccurrences(svc.id);
    return this.serviceWithPositions(svc.id);
  }

  async updateService(user: AuthenticatedUser, id: string, input: UpdateServiceInput) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const [existing] = await this.db
      .select()
      .from(checklistServices)
      .where(eq(checklistServices.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException("Service not found");
    const patch: Partial<typeof checklistServices.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.active !== undefined) patch.active = input.active;
    if (input.recurrenceKind !== undefined) patch.recurrenceKind = input.recurrenceKind;
    if (input.weekday !== undefined) patch.weekday = input.weekday;
    if (input.timeOfDay !== undefined) patch.timeOfDay = input.timeOfDay;
    await this.db.update(checklistServices).set(patch).where(eq(checklistServices.id, id));
    if (input.templateIds !== undefined) {
      const templateIds = [...new Set(input.templateIds)];
      for (const templateId of templateIds) await this.getTemplate(templateId);
      await this.db.delete(checklistServiceTemplates).where(eq(checklistServiceTemplates.serviceId, id));
      await this.writeServiceTemplates(id, templateIds);
    }
    if (input.positions !== undefined) {
      await this.db
        .delete(checklistServicePositions)
        .where(eq(checklistServicePositions.serviceId, id));
      await this.writeServicePositions(id, input.positions);
    }
    void this.generateOccurrences(id);
    return this.serviceWithPositions(id);
  }

  async deleteService(user: AuthenticatedUser, id: string, deleteFutureEvents = false) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    let deletedEvents = 0;
    if (deleteFutureEvents) {
      // Remove the still-upcoming occurrences this service generated (their
      // tasks + roster cascade). Past events are always kept. Must run before
      // the service delete, which set-nulls serviceId on any remaining events.
      const rows = await this.db
        .delete(checklistEvents)
        .where(and(eq(checklistEvents.serviceId, id), gte(checklistEvents.scheduledAt, new Date())))
        .returning({ id: checklistEvents.id });
      deletedEvents = rows.length;
    }
    await this.db.delete(checklistServices).where(eq(checklistServices.id, id));
    return { ok: true, deletedEvents };
  }

  async generateService(user: AuthenticatedUser, id: string) {
    if (!this.canAdmin(user)) throw new ForbiddenException("Missing checklists:admin");
    const created = await this.generateOccurrences(id);
    return { created };
  }

  private async writeServicePositions(serviceId: string, positions: ServicePositionInput[]) {
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (!p) continue;
      const [row] = await this.db
        .insert(checklistServicePositions)
        .values({ serviceId, positionName: posKey(p.positionName), sortOrder: i })
        .onConflictDoNothing()
        .returning();
      const positionId = row?.id;
      if (!positionId) continue;
      const ids = [...new Set(p.defaultUserIds)];
      if (ids.length) {
        await this.db
          .insert(checklistServicePositionDefaults)
          .values(ids.map((userId) => ({ servicePositionId: positionId, userId })))
          .onConflictDoNothing();
      }
    }
  }

  /**
   * Materialise a service's upcoming occurrences within the horizon. Idempotent
   * via the unique (serviceId, occurrenceDate) index — re-running only creates
   * dates that don't exist yet. Each new occurrence snapshots the tasks from
   * every linked template — concatenated in link order, with sortOrder
   * renumbered across the combination — and seeds the roster from the
   * service-position defaults. Returns the count created. No notifications
   * (occurrences are generated far ahead).
   */
  async generateOccurrences(serviceId: string): Promise<number> {
    const svc = await this.serviceWithPositions(serviceId);
    if (!svc.active || svc.recurrenceKind !== "weekly") return 0;
    const perTemplate = await Promise.all(svc.templateIds.map((tid) => this.templateTasks(tid)));
    // Each template belongs to one station; tag its tasks with that station name
    // (grouping key) and the template name (children label).
    const tmplRows = await this.db
      .select({
        id: checklistTemplates.id,
        name: checklistTemplates.name,
        stationName: checklistStations.name,
      })
      .from(checklistTemplates)
      .leftJoin(checklistStations, eq(checklistStations.id, checklistTemplates.stationId))
      .where(inArray(checklistTemplates.id, svc.templateIds));
    const tmplInfo = new Map(tmplRows.map((r) => [r.id, { name: r.name, station: posKey(r.stationName) }]));
    const tasks: {
      title: string;
      description: string | null;
      positionName: string;
      templateName: string | null;
      sortOrder: number;
    }[] = [];
    let order = 0;
    svc.templateIds.forEach((tid, i) => {
      const info = tmplInfo.get(tid);
      for (const t of perTemplate[i] ?? []) {
        tasks.push({
          title: t.title,
          description: t.description,
          positionName: info?.station ?? "General",
          templateName: info?.name ?? null,
          sortOrder: order++,
        });
      }
    });
    const [hh, mm] = svc.timeOfDay.split(":").map((n) => parseInt(n, 10));
    const dates: Date[] = [];
    const now = new Date();
    const cursor = new Date(now);
    cursor.setHours(hh ?? 9, mm ?? 0, 0, 0);
    // Advance to the next matching weekday.
    while (cursor.getDay() !== svc.weekday) cursor.setDate(cursor.getDate() + 1);
    const horizon = new Date(now.getTime() + RECURRENCE_HORIZON_DAYS * 86_400_000);
    while (cursor <= horizon) {
      if (cursor >= now) dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }

    let created = 0;
    for (const date of dates) {
      const [event] = await this.db
        .insert(checklistEvents)
        .values({
          // No single templateId — this occurrence's tasks come from svc.templateIds (plural).
          serviceId: svc.id,
          occurrenceDate: date,
          name: `${svc.name} — ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
          scheduledAt: date,
          createdByUserId: svc.createdByUserId,
        })
        .onConflictDoNothing()
        .returning();
      if (!event) continue; // already generated for this occurrence
      created++;
      if (tasks.length) {
        await this.db.insert(checklistEventTasks).values(
          tasks.map((t) => ({
            eventId: event.id,
            title: t.title,
            description: t.description,
            positionName: t.positionName,
            templateName: t.templateName,
            sortOrder: t.sortOrder,
          })),
        );
      }
      const byPosition = new Map<string, Set<string>>();
      for (const p of svc.positions) {
        if (p.defaultUserIds.length) byPosition.set(p.positionName, new Set(p.defaultUserIds));
      }
      await this.seedRoster(event.id, byPosition, "default");
    }
    return created;
  }
}

// Silence unused-import warnings for symbols future expansion will use.
void gte;
void inArray;
void ne;
void planningCenterLinks;
