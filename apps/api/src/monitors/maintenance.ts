import { MAINTENANCE_MODE_KEY, MAINTENANCE_UNTIL_KEY, maintenanceState, type MaintenanceState } from "@church/shared";
import type { SettingsService } from "../settings/settings.service";

/**
 * Whether alert notifications are silenced right now. Every fan-out point asks this instead of reading the
 * `monitoring.maintenance_mode` flag, so a window with an end time stops silencing on time (`maintenanceState` is the rule,
 * shared with the probe worker). A read that fails counts as "not in maintenance": an alert is better sent twice than lost.
 */
export async function readMaintenance(settings: Pick<SettingsService, "get">, now: number = Date.now()): Promise<MaintenanceState> {
  const [enabled, until] = await Promise.all([
    settings.get(MAINTENANCE_MODE_KEY).catch(() => false),
    settings.get(MAINTENANCE_UNTIL_KEY).catch(() => ""),
  ]);
  return maintenanceState(enabled, until, now);
}

export async function maintenanceActive(settings: Pick<SettingsService, "get">): Promise<boolean> {
  return (await readMaintenance(settings)).active;
}
