import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ALERT_KEYS, statusOverall, type StatusItem, type StatusPage } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { monitorIncidents, monitors } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { readMaintenance } from "./maintenance";

const ORDER: Record<StatusItem["state"], number> = { down: 0, flapping: 1, unknown: 2, up: 3 };

/**
 * The read-only status page every signed-in person may open: the monitors an admin chose to list, in plain words. It
 * carries names, state and "since" only; targets, addresses, error text and thresholds stay behind the Monitoring module.
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
}
