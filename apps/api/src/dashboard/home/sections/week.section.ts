import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  PERMISSIONS,
  addDaysInZone,
  buildWeek,
  sectionOk,
  startOfWeekInZone,
  zonedParts,
  type HealthRow,
  type IncidentSpan,
  type Section,
  type WeekDigest,
  type WeekEventInput,
} from "@church/shared";
import { DB, type Db } from "../../../db/db.module";
import { activityEvents, backupOperations, infraTargets, monitorIncidents, monitors, tickets } from "../../../db/schema";
import { AVAILABILITY_KINDS, AvailabilityStore } from "../../../availability/availability.store";
import { WikiService } from "../../../wiki/wiki.service";
import type { HomeContext, SectionBuilder } from "../home.types";
import { HomeServiceSection } from "./service.section";
import { TtlCache } from "../cache";
import { checklistEventsBetween, responseTargets, unansweredTickets } from "./week-queries";
import { SettingsService } from "../../../settings/settings.service";

/** "4 min", "2 h 10 min", "1 d 3 h". */
export function durationText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 === 0 ? `${hours} h` : `${hours} h ${mins % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/**
 * Reads that give every person the same answer (incidents, backups, the wiki edit log) are shared for this long,
 * so a burst of open home pages (a monitoring event wakes them all at once) costs one query, not one each. What is
 * per person (tickets, checklists, which wiki pages they may see) is still read for them.
 */
export const WEEK_SHARED_MS = 10_000;

@Injectable()
export class HomeWeekSection implements SectionBuilder<WeekDigest> {
  private readonly shared = new TtlCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly availability: AvailabilityStore,
    private readonly service: HomeServiceSection,
    private readonly wiki: WikiService,
  ) {}

  private async incidents(
    from: Date,
    to: Date,
  ): Promise<{ events: WeekEventInput[]; spans: IncidentSpan[] }> {
    const rows = await this.db
      .select({
        id: monitorIncidents.id,
        monitorId: monitorIncidents.monitorId,
        targetId: monitorIncidents.targetId,
        startedAt: monitorIncidents.startedAt,
        resolvedAt: monitorIncidents.resolvedAt,
        monitorName: monitors.name,
        targetName: infraTargets.name,
      })
      .from(monitorIncidents)
      .leftJoin(monitors, eq(monitors.id, monitorIncidents.monitorId))
      .leftJoin(infraTargets, eq(infraTargets.id, monitorIncidents.targetId))
      .where(
        and(
          lt(monitorIncidents.startedAt, to),
          or(isNull(monitorIncidents.resolvedAt), gte(monitorIncidents.resolvedAt, from)),
        ),
      )
      .limit(2000);
    const events: WeekEventInput[] = [];
    const spans: IncidentSpan[] = [];
    for (const r of rows) {
      spans.push({ start: r.startedAt, end: r.resolvedAt });
      if (r.startedAt.getTime() < from.getTime()) continue;
      const name = r.monitorName ?? r.targetName ?? "A system";
      const href = r.monitorId ? `/monitoring/${r.monitorId}` : r.targetId ? `/monitoring/infra/${r.targetId}` : null;
      events.push({
        kind: "incident",
        title: `${name} went down`,
        detail: r.resolvedAt ? `Back after ${durationText(r.resolvedAt.getTime() - r.startedAt.getTime())}` : "Still down",
        at: r.startedAt,
        tone: r.resolvedAt ? "warn" : "bad",
        href,
        group: r.monitorId ?? r.targetId ?? r.id,
        subject: name,
        durationMs: r.resolvedAt ? r.resolvedAt.getTime() - r.startedAt.getTime() : null,
      });
    }
    return { events, spans };
  }

  private async ticketEvents(ctx: HomeContext, from: Date, to: Date): Promise<WeekEventInput[]> {
    const user = ctx.user;
    const readAny = user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY);
    const conds = [gte(tickets.createdAt, from), lt(tickets.createdAt, to)];
    if (!readAny) conds.push(eq(tickets.createdByUserId, user.id));
    const [opened, waiting, targets] = await Promise.all([
      this.db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, createdAt: tickets.createdAt })
        .from(tickets)
        .where(and(...conds))
        .orderBy(desc(tickets.createdAt))
        .limit(200),
      unansweredTickets(this.db, user, null),
      responseTargets(this.settings),
    ]);
    const out: WeekEventInput[] = opened.map((t) => ({
      kind: "ticket",
      title: `#${Number(t.number)} opened`,
      detail: t.title,
      at: t.createdAt,
      tone: "info",
      href: `/tickets/${t.id}`,
    }));
    for (const t of waiting) {
      const target = targets[t.priority];
      if (target <= 0) continue;
      const due = new Date(t.createdAt.getTime() + target * 60_000);
      if (due.getTime() < from.getTime() || due.getTime() >= to.getTime()) continue;
      out.push({
        kind: "ticket",
        title: `#${t.number} response due`,
        detail: t.title,
        at: due,
        tone: "warn",
        href: `/tickets/${t.id}`,
      });
    }
    return out;
  }

  private async checklistEvents(ctx: HomeContext, from: Date, to: Date): Promise<WeekEventInput[]> {
    const events = await checklistEventsBetween(this.db, ctx.user, from, to);
    return events.map((e) => {
      const complete = e.total > 0 && e.done >= e.total;
      const missed = !complete && e.scheduledAt.getTime() < ctx.now.getTime();
      return {
        kind: "checklist",
        title: e.name,
        detail: e.total === 0 ? "No tasks" : `${e.done} of ${e.total} tasks done`,
        at: e.scheduledAt,
        tone: complete ? "ok" : missed ? "warn" : "info",
        href: `/checklists/${e.id}`,
      };
    });
  }

  private async planningCenterEvents(ctx: HomeContext, from: Date, to: Date): Promise<WeekEventInput[]> {
    // The next plan, from the same cached read the service section uses (no extra call).
    const built = await this.service.build(ctx);
    if (built.state !== "ok" || built.data.source !== "planning_center") return [];
    const svc = built.data;
    const at = svc.startsAt ? new Date(svc.startsAt) : null;
    if (!at || at.getTime() < from.getTime() || at.getTime() >= to.getTime()) return [];
    return [
      {
        kind: "service",
        title: svc.title,
        detail: svc.seriesTitle ?? svc.serviceTypeName,
        at,
        tone: "info",
        href: svc.href,
      },
    ];
  }

  private async backupEvents(from: Date, to: Date): Promise<WeekEventInput[]> {
    const rows = await this.db
      .select({ finishedAt: backupOperations.finishedAt, status: backupOperations.status })
      .from(backupOperations)
      .where(
        and(
          eq(backupOperations.kind, "backup"),
          inArray(backupOperations.status, ["succeeded", "failed"]),
          gte(backupOperations.finishedAt, from),
          lt(backupOperations.finishedAt, to),
        ),
      )
      .orderBy(desc(backupOperations.finishedAt))
      .limit(50);
    const out: WeekEventInput[] = [];
    for (const r of rows) {
      if (!r.finishedAt) continue;
      out.push({
        kind: "backup",
        title: r.status === "failed" ? "Backup failed" : "Backup finished",
        detail: null,
        at: r.finishedAt,
        tone: r.status === "failed" ? "bad" : "ok",
        href: "/admin/backups",
      });
    }
    return out;
  }

  private async wikiEvents(ctx: HomeContext, from: Date, to: Date): Promise<WeekEventInput[]> {
    const rows = await this.shared.get(`wiki|${from.getTime()}|${to.getTime()}`, WEEK_SHARED_MS, () => this.wikiActivityRows(from, to));
    if (rows.length === 0) return [];
    // Page ACLs: only pages the person can read.
    const visible = new Set((await this.wiki.list(ctx.user, { limit: 200 })).map((p) => p.id));
    const seen = new Set<string>();
    const out: WeekEventInput[] = [];
    for (const r of rows) {
      if (!r.resourceId || !visible.has(r.resourceId)) continue;
      const p = zonedParts(r.ts, ctx.timezone);
      const key = `${r.resourceId}:${p.year}-${p.month}-${p.day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = r.actorEmail ? (r.actorEmail.split("@")[0] ?? null) : null;
      const verb = r.action === "wiki.created" || r.action === "wiki.create" ? "Created" : "Updated";
      out.push({
        kind: "wiki",
        title: `Wiki: ${r.title}`,
        detail: who ? `${verb} by ${who}` : verb,
        at: r.ts,
        tone: "info",
        href: r.link ?? `/wiki/${r.resourceId}`,
      });
    }
    return out;
  }

  /** The wiki edit log for the week, the same for everyone (the caller drops pages the person cannot read). */
  private async wikiActivityRows(from: Date, to: Date) {
    return this.db
      .select({
        resourceId: activityEvents.resourceId,
        action: activityEvents.action,
        title: activityEvents.title,
        actorEmail: activityEvents.actorEmail,
        link: activityEvents.link,
        ts: activityEvents.ts,
      })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.resourceType, "wiki_page"),
          inArray(activityEvents.action, ["wiki.created", "wiki.updated", "wiki.update", "wiki.create", "wiki.revert"]),
          gte(activityEvents.ts, from),
          lt(activityEvents.ts, to),
        ),
      )
      .orderBy(desc(activityEvents.ts))
      .limit(200);
  }

  async build(ctx: HomeContext): Promise<Section<WeekDigest>> {
    const perms = ctx.user.permissions;
    const has = (p: string) => perms.includes(p);
    const tz = ctx.timezone;
    const from = startOfWeekInZone(ctx.now, tz);
    const to = addDaysInZone(from, tz, 7);

    const canMonitor = has(PERMISSIONS.MONITORS_READ_ANY);
    const kinds: string[] = canMonitor
      ? AVAILABILITY_KINDS.filter((k) => k !== "unifi_device" || has(PERMISSIONS.UNIFI_READ_ANY))
      : [];

    const empty = Promise.resolve<WeekEventInput[]>([]);
    const [inc, ticketEvents, checklistEvents, pcEvents, backupEvents, wikiEvents, rows] = await Promise.all([
      canMonitor
        ? this.shared.get(`inc|${from.getTime()}|${to.getTime()}`, WEEK_SHARED_MS, () => this.incidents(from, to))
        : Promise.resolve({ events: [] as WeekEventInput[], spans: [] as IncidentSpan[] }),
      has(PERMISSIONS.TICKETS_READ_OWN) ? this.ticketEvents(ctx, from, to) : empty,
      has(PERMISSIONS.CHECKLISTS_READ_ASSIGNED) ? this.checklistEvents(ctx, from, to) : empty,
      has(PERMISSIONS.PLANNING_CENTER_READ_ANY) ? this.planningCenterEvents(ctx, from, to) : empty,
      has(PERMISSIONS.SITE_ADMIN)
        ? this.shared.get(`backup|${from.getTime()}|${to.getTime()}`, WEEK_SHARED_MS, () => this.backupEvents(from, to))
        : empty,
      has(PERMISSIONS.WIKI_READ_OWN) ? this.wikiEvents(ctx, from, to) : empty,
      canMonitor ? this.availability.hourly(from, kinds) : Promise.resolve([]),
    ]);

    const health: { rows: HealthRow[]; incidents: IncidentSpan[] } | null = canMonitor
      ? {
          rows: rows.map((r) => ({ kind: r.kind, ref: r.ref, hour: r.hour, samples: r.samples, down: r.down })),
          incidents: inc.spans,
        }
      : null;

    return sectionOk(
      buildWeek({
        now: ctx.now,
        timezone: tz,
        events: [...inc.events, ...ticketEvents, ...checklistEvents, ...pcEvents, ...backupEvents, ...wikiEvents],
        health,
      }),
    );
  }
}
