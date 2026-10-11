import { Inject, Injectable } from "@nestjs/common";
import {
  PERMISSIONS,
  TICKET_PRIORITIES,
  sectionOff,
  sectionOk,
  ticketSlaStatus,
  type Section,
  type TicketDigest,
  type TicketSlaMap,
} from "@church/shared";
import { DB, type Db } from "../../../db/db.module";
import { SettingsService } from "../../../settings/settings.service";
import { TicketsService } from "../../../tickets/tickets.service";
import type { HomeContext, SectionBuilder } from "../home.types";
import { asPriority, asStatus, loadUserNames, numberOr } from "../names";

/** The most rows read to count open tickets; a church helpdesk is well below this. */
export const OPEN_TICKET_SCAN = 200;
export const MINE_LIMIT = 10;

@Injectable()
export class HomeTicketsSection implements SectionBuilder<TicketDigest> {
  constructor(
    private readonly tickets: TicketsService,
    private readonly settings: SettingsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Response targets only (a resolution clock is not shown on the home page). */
  private async slaMap(): Promise<TicketSlaMap> {
    const entries = await Promise.all(
      TICKET_PRIORITIES.map(async (p) => {
        const responseMin = numberOr(await this.settings.get(`tickets.sla.response_min.${p}`), 0);
        return [p, { responseMin, resolutionMin: 0 }] as const;
      }),
    );
    return Object.fromEntries(entries) as TicketSlaMap;
  }

  async build(ctx: HomeContext): Promise<Section<TicketDigest>> {
    const user = ctx.user;
    if (!user.permissions.includes(PERMISSIONS.TICKETS_READ_OWN)) return sectionOff("forbidden");
    const readAny = user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY);
    // TicketsService.assignedUserId can be set only with tickets:admin; see TicketsService.canAssign.
    const canAssign = user.permissions.includes(PERMISSIONS.TICKETS_ADMIN);

    const [open, sla] = await Promise.all([
      this.tickets.list(user, {
        scope: readAny ? "all" : "own",
        status: ["open", "in_progress"],
        limit: OPEN_TICKET_SCAN,
      }),
      this.slaMap(),
    ]);

    const mineRows = open
      .filter((t) => t.assignedUserId === user.id || (!readAny && t.createdByUserId === user.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, MINE_LIMIT);

    const names = await loadUserNames(this.db, mineRows.map((t) => t.createdByUserId));
    const mine = mineRows.map((t) => {
      const priority = asPriority(t.priority);
      const status = asStatus(t.status);
      const target = sla[priority].responseMin;
      const waiting = !t.firstResponseAt && target > 0;
      const dueAt = waiting ? new Date(t.createdAt.getTime() + target * 60_000) : null;
      const breached = ticketSlaStatus(
        {
          priority,
          createdAt: t.createdAt.toISOString(),
          firstResponseAt: t.firstResponseAt ? t.firstResponseAt.toISOString() : null,
          status,
          resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
        },
        sla,
        ctx.now,
      ).responseBreached;
      return {
        id: t.id,
        number: t.number,
        title: t.title,
        status,
        priority,
        requesterName: names.get(t.createdByUserId) ?? null,
        assignedToMe: t.assignedUserId === user.id,
        createdAt: t.createdAt.toISOString(),
        responseDueAt: dueAt ? dueAt.toISOString() : null,
        responseBreached: breached,
        href: `/tickets/${t.id}`,
      };
    });

    return sectionOk({
      mine,
      unassignedCount: readAny ? open.filter((t) => t.assignedUserId === null).length : 0,
      openCount: open.length,
      canAssign,
    });
  }
}
