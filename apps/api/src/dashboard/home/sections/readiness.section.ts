import { Inject, Injectable } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import {
  PERMISSIONS,
  computeReadiness,
  sectionOff,
  sectionOk,
  type Readiness,
  type ReadinessInput,
  type Section,
} from "@church/shared";
import { DB, type Db } from "../../../db/db.module";
import { monitors } from "../../../db/schema";
import { SettingsService } from "../../../settings/settings.service";
import type { HomeContext, DerivedSectionBuilder, PrimarySections } from "../home.types";
import { checklistEventsBetween, responseTargets, unansweredTickets } from "./week-queries";

const DAY_MS = 86_400_000;

@Injectable()
export class HomeReadinessSection implements DerivedSectionBuilder<Readiness> {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  private async stream(ctx: HomeContext): Promise<ReadinessInput["stream"]> {
    if (!ctx.user.permissions.includes(PERMISSIONS.MONITORS_READ_ANY)) return null;
    const raw = await this.settings.get("dashboard.stream_monitor_ids");
    const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v !== "") : [];
    if (ids.length === 0) return null;
    const rows = await this.db
      .select({ id: monitors.id, name: monitors.name, status: monitors.status })
      .from(monitors)
      .where(inArray(monitors.id, ids));
    // A monitor that was deleted since is simply no longer part of the check.
    return { monitors: rows.map((r) => ({ id: r.id, name: r.name, up: r.status === "up" })) };
  }

  private async runthrough(ctx: HomeContext, primary: PrimarySections): Promise<ReadinessInput["runthrough"]> {
    if (!ctx.user.permissions.includes(PERMISSIONS.CHECKLISTS_READ_ASSIGNED)) return null;
    if (primary.service.state !== "ok" || !primary.service.data.startsAt) return null;
    const service = new Date(primary.service.data.startsAt);
    if (Number.isNaN(service.getTime())) return null;
    const events = await checklistEventsBetween(this.db, ctx.user, new Date(service.getTime() - 7 * DAY_MS), service, "desc", 1);
    const latest = events[0];
    if (!latest) return null;
    return { name: latest.name, done: latest.done, total: latest.total, href: `/checklists/${latest.id}` };
  }

  private async helpdesk(ctx: HomeContext): Promise<ReadinessInput["helpdesk"]> {
    if (!ctx.user.permissions.includes(PERMISSIONS.TICKETS_READ_OWN)) return null;
    const [waiting, targets] = await Promise.all([
      unansweredTickets(this.db, ctx.user, ["urgent", "high"]),
      responseTargets(this.settings),
    ]);
    const breached = waiting
      .filter((t) => targets[t.priority] > 0 && t.createdAt.getTime() + targets[t.priority] * 60_000 <= ctx.now.getTime())
      .map((t) => ({ number: t.number, title: t.title, href: `/tickets/${t.id}` }));
    return { breached };
  }

  async build(ctx: HomeContext, primary: PrimarySections): Promise<Section<Readiness>> {
    const [stream, runthrough, helpdesk] = await Promise.all([
      this.stream(ctx),
      this.runthrough(ctx, primary),
      this.helpdesk(ctx),
    ]);
    const readiness = computeReadiness({
      systems: primary.systems.state === "ok" ? primary.systems.data : null,
      service: primary.service.state === "ok" ? primary.service.data : null,
      stream,
      runthrough,
      helpdesk,
    });
    if (readiness.total === 0) return sectionOff("unavailable", "nothing to check");
    return sectionOk(readiness);
  }
}
