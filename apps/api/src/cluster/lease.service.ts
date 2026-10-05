import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { LEASE_STORE, type LeaseStore } from "./lease.store";
import { NodeService } from "./node.service";

/**
 * Lease TTL for `job:` leases. A node that dies is replaced once its lease
 * lapses, so this is also roughly how long its jobs stall (plus up to one
 * renewal interval for another node to notice).
 */
export const JOB_LEASE_TTL_SEC = 30;

export interface Mutex {
  /** True once a renewal found the lease taken over (this node stalled past the TTL). */
  readonly lost: boolean;
  release(): Promise<void>;
}

/**
 * Database-backed leases (docs/multi-node.md). Two uses:
 *
 *  - `job:<name>`   elects which node runs a periodic job. Held for as long as the
 *                   node keeps renewing (see ClusterJobs).
 *  - `mutex:<name>` serialises a unit of work that any node may start, such as a DNS
 *                   sync triggered from the UI on whichever node served the request.
 *                   Each acquisition is its own holder, so it also excludes a second
 *                   caller in the same process.
 */
@Injectable()
export class LeaseService implements OnModuleDestroy {
  private readonly logger = new Logger(LeaseService.name);
  /** `job:` leases this process has taken, so they can be released on shutdown. */
  private readonly held = new Set<string>();

  constructor(
    @Inject(LEASE_STORE) private readonly store: LeaseStore,
    private readonly node: NodeService,
  ) {}

  /** Take or renew a lease as this process. Null when another holder has it. */
  async acquire(name: string, ttlSec: number): Promise<{ epoch: number } | null> {
    const res = await this.store.acquire(name, this.node.identity.holder, ttlSec);
    if (res) this.held.add(name);
    else this.held.delete(name);
    return res;
  }

  /**
   * Take a mutex for the duration of some work, renewing it while the work runs.
   * Returns null when another holder has it. Always `release()` it, in a finally.
   */
  async acquireMutex(name: string, ttlSec: number): Promise<Mutex | null> {
    const lease = `mutex:${name}`;
    const holder = `${this.node.identity.holder}#${randomUUID().slice(0, 8)}`;
    const first = await this.store.acquire(lease, holder, ttlSec);
    if (!first) return null;

    let lost = false;
    let released = false;
    const timer = setInterval(() => {
      void this.store
        .acquire(lease, holder, ttlSec)
        .then((res) => {
          if (!res && !released) {
            lost = true;
            this.logger.warn(`mutex ${name} was taken over while still running`);
          }
        })
        .catch((err: unknown) => this.logger.debug(`mutex ${name} renew failed: ${(err as Error).message}`));
    }, Math.max(1000, (ttlSec * 1000) / 3));
    timer.unref();

    return {
      get lost() {
        return lost;
      },
      release: async () => {
        released = true;
        clearInterval(timer);
        await this.store.release(lease, holder).catch(() => undefined);
      },
    };
  }

  /** Run `fn` holding a mutex; `{ ran: false }` if someone else holds it. */
  async withMutex<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const mutex = await this.acquireMutex(name, ttlSec);
    if (!mutex) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await mutex.release();
    }
  }

  /** Give up every `job:` lease this process holds, so another node takes over at once. */
  async releaseAll(): Promise<void> {
    const names = [...this.held];
    this.held.clear();
    await Promise.all(
      names.map((n) => this.store.release(n, this.node.identity.holder).catch(() => undefined)),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([this.releaseAll(), new Promise((r) => setTimeout(r, 2000))]);
  }
}
