import { Injectable } from "@nestjs/common";
import { PERMISSIONS, sectionOff, sectionOk, type ChecklistDigest, type Section } from "@church/shared";
import { ChecklistsService } from "../../../checklists/checklists.service";
import type { HomeContext, SectionBuilder } from "../home.types";

export const CHECKLIST_EVENT_LIMIT = 5;
export const CHECKLIST_TASK_LIMIT = 8;

@Injectable()
export class HomeChecklistsSection implements SectionBuilder<ChecklistDigest> {
  constructor(private readonly checklists: ChecklistsService) {}

  async build(ctx: HomeContext): Promise<Section<ChecklistDigest>> {
    if (!ctx.user.permissions.includes(PERMISSIONS.CHECKLISTS_READ_ASSIGNED)) return sectionOff("forbidden");
    // Already ordered by event time, then task order.
    const rows = await this.checklists.myOpenTasks(ctx.user);
    const events = new Map<string, ChecklistDigest["events"][number]>();
    for (const r of rows) {
      let ev = events.get(r.eventId);
      if (!ev) {
        if (events.size >= CHECKLIST_EVENT_LIMIT) continue;
        ev = {
          eventId: r.eventId,
          name: r.eventName,
          scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
          href: `/checklists/${r.eventId}`,
          tasks: [],
        };
        events.set(r.eventId, ev);
      }
      if (ev.tasks.length < CHECKLIST_TASK_LIMIT) {
        ev.tasks.push({ taskId: r.taskId, title: r.title, positionName: r.positionName, done: false });
      }
    }
    return sectionOk({ events: [...events.values()] });
  }
}
