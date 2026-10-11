import { Inject, Injectable } from "@nestjs/common";
import { and, gte, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { availabilityHourly } from "../db/schema";

export const AVAILABILITY_KINDS = ["monitor", "infra_target", "unifi_device", "cisco_switch", "dns_node"] as const;
export type AvailabilityKind = (typeof AVAILABILITY_KINDS)[number];

export interface AvailabilitySample {
  kind: AvailabilityKind;
  ref: string;
  label: string;
  down: boolean;
}

export interface HourlyRow {
  kind: string;
  ref: string;
  label: string;
  /** ISO string of the UTC hour start. */
  hour: string;
  samples: number;
  down: number;
}

/** What the sampler needs from the store (so tests can fake it). */
export interface AvailabilityWriter {
  record(samples: AvailabilitySample[], hour: Date): Promise<void>;
  prune(before: Date): Promise<number>;
}

const CHUNK = 500;

/** Start of the UTC hour containing `at`. */
export function utcHourStart(at: Date): Date {
  const d = new Date(at.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

@Injectable()
export class AvailabilityStore implements AvailabilityWriter {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Adds one tick of samples to `hour`'s counters, one multi-row upsert per 500 systems. */
  async record(samples: AvailabilitySample[], hour: Date): Promise<void> {
    // Two samples for the same system in one statement would hit the conflict twice; fold them.
    const folded = new Map<string, { s: AvailabilitySample; samples: number; down: number }>();
    for (const s of samples) {
      const key = `${s.kind}\u0000${s.ref}`;
      const cur = folded.get(key);
      if (cur) {
        cur.samples += 1;
        cur.down += s.down ? 1 : 0;
        cur.s = s;
      } else folded.set(key, { s, samples: 1, down: s.down ? 1 : 0 });
    }
    const rows = [...folded.values()];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db
        .insert(availabilityHourly)
        .values(
          chunk.map((r) => ({
            kind: r.s.kind,
            ref: r.s.ref,
            hour,
            label: r.s.label,
            samples: r.samples,
            down: r.down,
          })),
        )
        .onConflictDoUpdate({
          target: [availabilityHourly.kind, availabilityHourly.ref, availabilityHourly.hour],
          set: {
            samples: sql`${availabilityHourly.samples} + excluded.samples`,
            down: sql`${availabilityHourly.down} + excluded.down`,
            label: sql`excluded.label`,
          },
        });
    }
  }

  /** Deletes hours before `before` in batches of 500; returns how many rows went. */
  async prune(before: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const res = await this.db.execute(sql`
        DELETE FROM availability_hourly
        WHERE (kind, ref, hour) IN (
          SELECT kind, ref, hour FROM availability_hourly WHERE hour < ${before.toISOString()}::timestamp LIMIT ${CHUNK}
        )`);
      const n = Number(res.rowCount ?? 0);
      total += n;
      if (n < CHUNK) return total;
    }
  }

  /** Rows from `since` (inclusive), optionally limited to some kinds. */
  async hourly(since: Date, kinds?: string[]): Promise<HourlyRow[]> {
    const where =
      kinds && kinds.length > 0
        ? and(gte(availabilityHourly.hour, since), inArray(availabilityHourly.kind, kinds))
        : gte(availabilityHourly.hour, since);
    const rows = await this.db.select().from(availabilityHourly).where(where).orderBy(availabilityHourly.hour);
    return rows.map((r) => ({
      kind: r.kind,
      ref: r.ref,
      label: r.label,
      hour: r.hour.toISOString(),
      samples: Number(r.samples),
      down: Number(r.down),
    }));
  }
}
