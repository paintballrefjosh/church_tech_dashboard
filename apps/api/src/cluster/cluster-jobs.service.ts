import { Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { JOB_LEASE_TTL_SEC, LeaseService } from "./lease.service";
import { NodeService } from "./node.service";
import { RestoreGate } from "./restore-gate";

/** How often a node renews the leases it holds and tries for ones that are free. */
export const LEASE_RENEW_MS = 10_000;
/** A node stops acting as leader this long before its lease could actually lapse. */
const LEADER_SAFETY_MS = 2_000;
/** How long shutdown waits for running jobs before giving up on them. */
const SHUTDOWN_WAIT_MS = 6_000;

export interface ClusterJobSpec {
  /** Unique, stable. Becomes the lease name `job:<name>`. */
  name: string;
  /** Milliseconds between runs. A function is re-read before every run, so a cadence from settings can change without a restart. */
  everyMs: number | (() => number | Promise<number>);
  /** Delay before the first run. Default: `everyMs` for fixed-rate, 10s for fixed-delay. */
  initialDelayMs?: number;
  /**
   * `fixed-rate` (default) starts a run every `everyMs` regardless of how long the
   * last took, like `setInterval`, so a job with its own in-flight guards can
   * overlap itself. `fixed-delay` waits `everyMs` after a run finishes, like a
   * self-rescheduling `setTimeout`.
   */
  schedule?: "fixed-rate" | "fixed-delay";
  run: () => Promise<void>;
}

interface JobEntry {
  spec: ClusterJobSpec;
  timer: NodeJS.Timeout | null;
  /** Local-monotonic time until which this node may act as the job's leader. */
  leaderUntil: number;
  /** The last refresh failed; used to log a failure once, not every renewal. */
  failing: boolean;
}

/**
 * Runs periodic jobs on exactly one node at a time (docs/multi-node.md).
 *
 * Every node registers the same jobs and runs the same timers. A timer firing
 * only does work while this node holds the job's `job:<name>` lease, which a
 * keeper loop renews every {@link LEASE_RENEW_MS}. A node that is stopped, loses
 * the database, or stalls past the TTL stops being leader; another node's keeper
 * picks the lease up once it lapses (about {@link JOB_LEASE_TTL_SEC}s, or at once
 * for a clean shutdown, which releases its leases).
 *
 * On a single node it always wins, so behaviour matches the old per-module
 * `setInterval`s.
 *
 * Use this for anything that must not run twice at once. Do not add a bare
 * `setInterval` for such work: it would run on every node.
 */
@Injectable()
export class ClusterJobs implements OnModuleDestroy {
  private readonly logger = new Logger(ClusterJobs.name);
  private readonly jobs = new Map<string, JobEntry>();
  private keeper: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Runs in progress, so shutdown can let them finish before the database closes. */
  private readonly running = new Set<Promise<void>>();
  /** Monotonic milliseconds. A field so tests can drive it alongside fake timers. */
  clock: () => number = () => performance.now();

  constructor(
    private readonly leases: LeaseService,
    private readonly node: NodeService,
    /** While a backup restore rewrites the database, no job runs (nothing else may write). Absent in unit tests. */
    @Optional() private readonly gate?: RestoreGate,
  ) {}

  register(spec: ClusterJobSpec): void {
    if (this.jobs.has(spec.name)) throw new Error(`cluster job already registered: ${spec.name}`);
    const entry: JobEntry = { spec, timer: null, leaderUntil: 0, failing: false };
    this.jobs.set(spec.name, entry);

    const fixedDelay = spec.schedule === "fixed-delay";
    const first = spec.initialDelayMs ?? (fixedDelay ? 10_000 : undefined);
    void (async () => {
      // Claim the lease straight away so the first run is not held back a renewal interval.
      await this.refresh(entry);
      this.arm(entry, first ?? (await this.delayOf(spec)));
    })();

    if (!this.keeper && !this.stopped) {
      this.keeper = setInterval(() => void this.renewAll(), LEASE_RENEW_MS);
      this.keeper.unref();
    }
  }

  /** Whether this node currently leads the job. For tests and the admin page. */
  isLeader(name: string): boolean {
    const e = this.jobs.get(name);
    return !!e && this.clock() < e.leaderUntil;
  }

  /** Names of the jobs this node currently leads. */
  leading(): string[] {
    return [...this.jobs.keys()].filter((n) => this.isLeader(n));
  }

  private async delayOf(spec: ClusterJobSpec): Promise<number> {
    const v = typeof spec.everyMs === "function" ? await spec.everyMs() : spec.everyMs;
    return Math.max(1000, v);
  }

  private arm(entry: JobEntry, delayMs: number): void {
    if (this.stopped) return;
    entry.timer = setTimeout(() => void this.fire(entry), delayMs);
    entry.timer.unref();
  }

  private async fire(entry: JobEntry): Promise<void> {
    if (this.stopped) return;
    const { spec } = entry;
    const fixedDelay = spec.schedule === "fixed-delay";
    // Fixed-rate: line up the next run before this one starts, so a slow run does not shift the cadence.
    if (!fixedDelay) this.arm(entry, await this.delayOf(spec).catch(() => 60_000));
    if (this.isLeader(spec.name) && !(await this.gate?.isRestoring())) {
      const run: Promise<void> = Promise.resolve()
        .then(() => spec.run())
        .catch((err: unknown) => this.logger.warn(`job ${spec.name} failed: ${(err as Error).message}`))
        .finally(() => this.running.delete(run));
      this.running.add(run);
      await run;
    }
    if (fixedDelay) this.arm(entry, await this.delayOf(spec).catch(() => 60_000));
  }

  private async renewAll(): Promise<void> {
    for (const entry of this.jobs.values()) await this.refresh(entry);
  }

  /** Renew the lease if we hold it, take it if it is free; record what happened. */
  private async refresh(entry: JobEntry): Promise<void> {
    if (!this.node.identity.backgroundJobs || this.stopped) {
      entry.leaderUntil = 0;
      return;
    }
    const startedAt = this.clock();
    try {
      const res = await this.leases.acquire(`job:${entry.spec.name}`, JOB_LEASE_TTL_SEC);
      entry.failing = false;
      if (res) {
        if (entry.leaderUntil === 0 || this.clock() >= entry.leaderUntil) {
          this.logger.log(`now leading job ${entry.spec.name} (epoch ${res.epoch})`);
        }
        // Measured from before the request went out, so a slow round trip cannot extend our claim.
        entry.leaderUntil = startedAt + JOB_LEASE_TTL_SEC * 1000 - LEADER_SAFETY_MS;
      } else {
        if (entry.leaderUntil > 0) this.logger.log(`no longer leading job ${entry.spec.name}`);
        entry.leaderUntil = 0;
      }
    } catch (err) {
      // Database trouble: keep leading until the claim lapses on its own clock.
      // Warn once per outage; a fresh install logs this until migrations are applied.
      const msg = `lease refresh for ${entry.spec.name} failed: ${(err as Error).message}`;
      if (entry.failing) this.logger.debug(msg);
      else this.logger.warn(msg);
      entry.failing = true;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.keeper) clearInterval(this.keeper);
    this.keeper = null;
    for (const e of this.jobs.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.leaderUntil = 0;
    }
    // Let runs in progress finish (a few seconds at most) before the database closes
    // under them, then hand the leases over: releasing first would let another
    // node start the same job while this one is still finishing it.
    if (this.running.size > 0) {
      this.logger.log(`waiting for ${this.running.size} running job(s) to finish`);
      await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS))]);
    }
    await this.leases.releaseAll();
  }
}
