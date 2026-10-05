import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { acquireLease, releaseLease } from "@church/shared/db";
import { DB_POOL } from "../db/db.module";

/**
 * Storage behind {@link LeaseService}. The database one is the real thing; tests
 * use an in-memory one with the same semantics.
 */
export interface LeaseStore {
  /**
   * Take the lease if it is free, expired, or already ours (which renews it).
   * Returns the lease epoch on success and null when someone else holds it.
   */
  acquire(name: string, holder: string, ttlSec: number): Promise<{ epoch: number } | null>;
  /** Give the lease up early. A no-op unless `holder` still holds it. */
  release(name: string, holder: string): Promise<void>;
}

export const LEASE_STORE = Symbol("LEASE_STORE");

// The SQL lives in @church/shared/db so the migrate script and the monitor worker
// use exactly the same statements. Re-exported for existing importers.
export { acquireLease, releaseLease };

@Injectable()
export class DbLeaseStore implements LeaseStore {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  acquire(name: string, holder: string, ttlSec: number): Promise<{ epoch: number } | null> {
    return acquireLease(this.pool, name, holder, ttlSec);
  }

  release(name: string, holder: string): Promise<void> {
    return releaseLease(this.pool, name, holder);
  }
}
