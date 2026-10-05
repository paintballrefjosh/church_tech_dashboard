import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { jobState } from "../db/schema";

/**
 * Small pieces of state a job carries between runs, stored in the database so
 * they survive the job moving to another node: alert baselines, consecutive
 * failure counters. JSON values; not for anything bulky or frequently written.
 */
@Injectable()
export class JobStateService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The stored value and how old it is, or null when nothing is stored. */
  async get<T>(job: string, key: string): Promise<{ value: T; ageMs: number } | null> {
    const [row] = await this.db
      .select({
        value: jobState.value,
        ageMs: sql<number>`(extract(epoch from (now() - ${jobState.updatedAt})) * 1000)`,
      })
      .from(jobState)
      .where(and(eq(jobState.job, job), eq(jobState.key, key)))
      .limit(1);
    return row ? { value: row.value as T, ageMs: Number(row.ageMs) } : null;
  }

  async set(job: string, key: string, value: unknown): Promise<void> {
    await this.db
      .insert(jobState)
      .values({ job, key, value: value as never })
      .onConflictDoUpdate({
        target: [jobState.job, jobState.key],
        set: { value: value as never, updatedAt: sql`now()` },
      });
  }

  async delete(job: string, key: string): Promise<void> {
    await this.db.delete(jobState).where(and(eq(jobState.job, job), eq(jobState.key, key)));
  }
}
