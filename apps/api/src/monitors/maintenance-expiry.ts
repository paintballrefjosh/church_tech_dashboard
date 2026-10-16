import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { MAINTENANCE_MODE_KEY, MAINTENANCE_UNTIL_KEY, maintenanceState } from "@church/shared";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";

/**
 * Turns the maintenance switch off once its end time has passed. Nothing depends on this for correctness (every reader
 * judges the end time itself, `maintenanceState`), it keeps the stored switch and the settings page honest. One node does
 * it (cluster job); the state is read again right before writing, so a window set again meanwhile is not undone.
 */
@Injectable()
export class MaintenanceExpiry implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceExpiry.name);

  constructor(
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "maintenance-expiry", everyMs: 60_000, initialDelayMs: 30_000, run: async () => void (await this.run()) });
  }

  async run(now: number = Date.now()): Promise<boolean> {
    const read = async () => maintenanceState(await this.settings.get(MAINTENANCE_MODE_KEY), await this.settings.get(MAINTENANCE_UNTIL_KEY), now);
    if (!(await read()).expired) return false;
    if (!(await read()).expired) return false;
    await this.settings.set(MAINTENANCE_MODE_KEY, false, null);
    await this.settings.set(MAINTENANCE_UNTIL_KEY, "", null);
    this.logger.log("maintenance mode ended: its end time passed, alerts are on again");
    return true;
  }
}
