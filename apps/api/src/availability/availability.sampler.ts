import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { AvailabilityStore, utcHourStart, type AvailabilitySample, type AvailabilityWriter } from "./availability.store";
import { AVAILABILITY_SOURCES, type AvailabilitySources } from "./availability.sources";

export const SAMPLE_EVERY_MS = 60_000;
export const PRUNE_EVERY_MS = 60 * 60_000;
export const KEEP_DAYS = 8;

/**
 * Records one availability sample per system each minute into the current UTC hour, on the
 * node that holds the job lease. Reads current state only; a source that is unconfigured or
 * fails contributes nothing this tick ("no data", never "down").
 */
@Injectable()
export class AvailabilitySampler implements OnModuleInit {
  private readonly logger = new Logger(AvailabilitySampler.name);

  constructor(
    @Inject(AVAILABILITY_SOURCES) private readonly sources: AvailabilitySources,
    @Inject(AvailabilityStore) private readonly store: AvailabilityWriter,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "availability-sample", everyMs: SAMPLE_EVERY_MS, run: () => this.sample().then(() => undefined) });
    this.jobs.register({
      name: "availability-prune",
      everyMs: PRUNE_EVERY_MS,
      schedule: "fixed-delay",
      run: () => this.prune().then(() => undefined),
    });
  }

  async sample(now: Date = new Date()): Promise<number> {
    const readers: [string, () => Promise<AvailabilitySample[] | null>][] = [
      ["monitor", () => this.sources.monitors()],
      ["infra_target", () => this.sources.infraTargets()],
      ["unifi_device", () => this.sources.unifiDevices()],
      ["cisco_switch", () => this.sources.ciscoSwitches()],
      ["dns_node", () => this.sources.dnsNodes()],
      ["service_instance", () => this.sources.serviceInstances()],
      ["service_group", () => this.sources.serviceGroups()],
    ];
    const results = await Promise.all(
      readers.map(async ([kind, read]) => {
        try {
          return (await read()) ?? [];
        } catch (err) {
          this.logger.debug(`availability: ${kind} skipped this tick: ${(err as Error).message}`);
          return [];
        }
      }),
    );
    const samples = results.flat();
    if (samples.length === 0) return 0;
    await this.store.record(samples, utcHourStart(now));
    return samples.length;
  }

  async prune(now: Date = new Date()): Promise<number> {
    return this.store.prune(new Date(now.getTime() - KEEP_DAYS * 24 * 3600_000));
  }
}
