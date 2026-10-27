import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ALERT_KEYS, statusOverall, type StatusItem, type StatusPage } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { monitorIncidents, monitors, serviceGroups } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { readMaintenance } from "./maintenance";

const ORDER: Record<StatusItem["state"], number> = { down: 0, flapping: 1, unknown: 2, up: 3 };

/**
 * The read-only status page every signed-in person may open: the monitors an admin chose to list, in plain words. It
 * carries names, state and "since" only; targets, addresses, error text and thresholds stay behind the Monitoring module.
 * Service groups chosen for it are listed too, by name only (never their members or hosts): down while a group incident is
 * open or the last judgement said so, otherwise up (a group that lost a spare still works) or unknown.
 */
@Injectable()
export class StatusService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async page(now: Date = new Date()): Promise<StatusPage> {
    const rows = await this.db
      .select({
        id: monitors.id,
        name: monitors.name,
        statusName: monitors.statusName,
        status: monitors.status,
        flappingSince: monitors.flappingSince,
      })
      .from(monitors)
      .where(and(eq(monitors.enabled, true), eq(monitors.showOnStatus, true)));

    const open = rows.length
      ? await this.db
          .select({ monitorId: monitorIncidents.monitorId, startedAt: monitorIncidents.startedAt, acknowledgedAt: monitorIncidents.acknowledgedAt })
          .from(monitorIncidents)
          .where(
            and(
              isNull(monitorIncidents.resolvedAt),
              inArray(
                monitorIncidents.monitorId,
                rows.map((r) => r.id),
              ),
            ),
          )
      : [];
    const openBy = new Map<string, (typeof open)[number]>();
    for (const o of open) {
      if (!o.monitorId) continue;
      const prev = openBy.get(o.monitorId);
      if (!prev || prev.startedAt > o.startedAt) openBy.set(o.monitorId, o);
    }

    const groups = await this.groupItems();
    const items: StatusItem[] = rows
      .map((r): StatusItem => {
        const inc = openBy.get(r.id);
        const down = r.status === "down";
        const flapping = r.flappingSince !== null;
        return {
          id: r.id,
          name: r.statusName?.trim() || r.name,
          state: down ? "down" : flapping ? "flapping" : r.status === "up" ? "up" : "unknown",
          since: down ? (inc?.startedAt ?? null)?.toISOString() ?? null : flapping ? r.flappingSince?.toISOString() ?? null : null,
          acknowledged: down && Boolean(inc?.acknowledgedAt),
        };
      })
      .concat(groups)
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));

    const maintenance = await readMaintenance(this.settings);
    const notice = await this.settings.get(ALERT_KEYS.statusNotice).catch(() => "");
    return {
      overall: statusOverall(items),
      items,
      maintenance: { enabled: maintenance.active, until: maintenance.active && maintenance.until !== null ? new Date(maintenance.until).toISOString() : null },
      notice: typeof notice === "string" ? notice.trim() : "",
      generatedAt: now.toISOString(),
    };
  }

  private async groupItems(): Promise<StatusItem[]> {
    const rows = await this.db
      .select({ id: serviceGroups.id, name: serviceGroups.name, statusName: serviceGroups.statusName, status: serviceGroups.status })
      .from(serviceGroups)
      .where(eq(serviceGroups.showOnStatus, true));
    if (!rows.length) return [];
    // A group's own warnings (a lost spare) do not make it "down": only its critical rules (quorum, role) do.
    const open = await this.db
      .select({ groupId: monitorIncidents.serviceGroupId, ruleId: monitorIncidents.ruleId, startedAt: monitorIncidents.startedAt, acknowledgedAt: monitorIncidents.acknowledgedAt })
      .from(monitorIncidents)
      .where(and(isNull(monitorIncidents.resolvedAt), inArray(monitorIncidents.serviceGroupId, rows.map((r) => r.id))));
    const openBy = new Map<string, (typeof open)[number]>();
    for (const o of open) {
      if (!o.groupId || o.ruleId === "group:redundancy") continue;
      const prev = openBy.get(o.groupId);
      if (!prev || prev.startedAt > o.startedAt) openBy.set(o.groupId, o);
    }
    return rows.map((r): StatusItem => {
      const inc = openBy.get(r.id);
      const down = r.status === "down" || inc !== undefined;
      return {
        id: r.id,
        name: r.statusName?.trim() || r.name,
        state: down ? "down" : r.status === "up" || r.status === "degraded" ? "up" : "unknown",
        since: down ? (inc?.startedAt.toISOString() ?? null) : null,
        acknowledged: down && Boolean(inc?.acknowledgedAt),
      };
    });
  }
}
