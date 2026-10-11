import { Inject, Injectable, Optional } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PERMISSIONS, sectionOff, sectionOk, type NextService, type Section } from "@church/shared";
import { PlanningCenterService } from "../../../planning-center/planning-center.service";
import { ChecklistsService } from "../../../checklists/checklists.service";
import type { HomeContext, SectionBuilder } from "../home.types";
import { TtlCache } from "../cache";
import { DB, type Db } from "../../../db/db.module";
import { checklistServices } from "../../../db/schema";

/** Planning Center is rate limited, and the next service changes slowly. */
export const PC_CACHE_MS = 5 * 60_000;

type PersonStatus = "confirmed" | "waiting" | "declined";

type PcLoad = { kind: "unconfigured" } | { kind: "none" } | { kind: "plan"; data: NextService };

export function personStatus(code: string | null): PersonStatus {
  if (code === "C") return "confirmed";
  if (code === "D") return "declined";
  return "waiting";
}

/** Pure mapping of a Planning Center plan to the snapshot shape (everyone is `isMe: false`). */
export function mapPlan(
  plan: { id: string; title: string; sortDate: string | null; seriesTitle: string | null; serviceTypeId: string; serviceTypeName: string | null },
  detail: Awaited<ReturnType<PlanningCenterService["planDetail"]>>,
): NextService {
  const times = detail.times
    .map((t) => ({ id: t.id, kind: t.kind, name: t.name ?? t.description, startsAt: t.startsAt, endsAt: t.endsAt }))
    .sort((a, b) => {
      if (a.startsAt === b.startsAt) return 0;
      if (a.startsAt === null) return 1;
      if (b.startsAt === null) return -1;
      return Date.parse(a.startsAt) - Date.parse(b.startsAt);
    });
  const firstService = times.find((t) => t.kind === "service" && t.startsAt);
  const startsAt = firstService?.startsAt ?? times[0]?.startsAt ?? plan.sortDate ?? null;

  let team: NextService["team"] = null;
  if (detail.assignments.length > 0) {
    const positions = new Map<string, NonNullable<NextService["team"]>["positions"][number]>();
    let confirmed = 0;
    let waiting = 0;
    let declined = 0;
    for (const a of detail.assignments) {
      const status = personStatus(a.status);
      if (status === "confirmed") confirmed++;
      else if (status === "declined") declined++;
      else waiting++;
      let pos = positions.get(a.positionName);
      if (!pos) {
        pos = { name: a.positionName, people: [] };
        positions.set(a.positionName, pos);
      }
      pos.people.push({ name: a.pcPersonName, status, isMe: false, localUserId: a.localUserId });
    }
    team = { confirmed, waiting, declined, positions: [...positions.values()] };
  }

  return {
    source: "planning_center",
    title: plan.title,
    seriesTitle: plan.seriesTitle,
    serviceTypeName: plan.serviceTypeName,
    href: `/planning-center/${plan.serviceTypeId}/${plan.id}`,
    startsAt,
    times,
    team,
  };
}

/** Marks the asking person's own rows. Returns a copy: the cached value is shared by everyone. */
export function markMe(service: NextService, userId: string): NextService {
  if (!service.team) return service;
  return {
    ...service,
    team: {
      ...service.team,
      positions: service.team.positions.map((p) => ({
        ...p,
        people: p.people.map((x) => ({ ...x, isMe: x.localUserId !== null && x.localUserId === userId })),
      })),
    },
  };
}

@Injectable()
export class HomeServiceSection implements SectionBuilder<NextService> {
  private readonly cache = new TtlCache();

  constructor(
    private readonly pc: PlanningCenterService,
    private readonly checklists: ChecklistsService,
    @Optional() @Inject(DB) private readonly db?: Db,
  ) {}

  private async loadPc(): Promise<PcLoad> {
    const plans = await this.pc.listUpcomingPlans({ limit: 1 });
    const plan = plans[0];
    if (!plan) {
      // No plans can mean "not configured" or "nothing scheduled"; ask which.
      const health = await this.pc.health();
      if (!health.configured) return { kind: "unconfigured" };
      if (!health.reachable) throw new Error(health.error ?? "Planning Center unreachable");
      return { kind: "none" };
    }
    const detail = await this.pc.planDetail(plan.serviceTypeId, plan.id);
    return { kind: "plan", data: mapPlan(plan, detail) };
  }

  private async nextChecklistEvent(ctx: HomeContext): Promise<NextService | null> {
    const events = await this.checklists.listEvents(ctx.user, { upcomingOnly: true });
    const next = events.find((e) => e.scheduledAt && e.scheduledAt.getTime() >= ctx.now.getTime());
    if (!next || !next.scheduledAt) return null;
    const startsAt = next.scheduledAt.toISOString();
    // Events generated from a recurring service are named "<service> - <date>"; the date is shown
    // separately, so title the service by its own name. The event was already permission-checked.
    let title = next.name;
    if (next.serviceId && this.db) {
      const [svc] = await this.db
        .select({ name: checklistServices.name })
        .from(checklistServices)
        .where(eq(checklistServices.id, next.serviceId))
        .limit(1);
      if (svc?.name) title = svc.name;
    }
    return {
      source: "checklist",
      title,
      seriesTitle: null,
      serviceTypeName: null,
      href: `/checklists/${next.id}`,
      startsAt,
      times: [{ id: next.id, kind: "service", name: null, startsAt, endsAt: null }],
      team: null,
    };
  }

  async build(ctx: HomeContext): Promise<Section<NextService>> {
    const perms = ctx.user.permissions;
    const canPc = perms.includes(PERMISSIONS.PLANNING_CENTER_READ_ANY);
    const canChecklist = perms.includes(PERMISSIONS.CHECKLISTS_READ_ASSIGNED);
    if (!canPc && !canChecklist) return sectionOff("forbidden");

    let pcState: "unconfigured" | "none" | "failed" = canPc ? "unconfigured" : "none";
    if (canPc) {
      try {
        const loaded = await this.cache.get("pc-next", PC_CACHE_MS, () => this.loadPc());
        if (loaded.kind === "plan") return sectionOk(markMe(loaded.data, ctx.user.id));
        pcState = loaded.kind;
      } catch {
        pcState = "failed";
      }
    }

    if (canChecklist) {
      const fallback = await this.nextChecklistEvent(ctx);
      if (fallback) return sectionOk(fallback);
    }
    if (pcState === "unconfigured") return sectionOff("unconfigured");
    if (pcState === "none") return sectionOff("unavailable", "no upcoming service");
    return sectionOff("unavailable", "Planning Center unreachable");
  }
}
