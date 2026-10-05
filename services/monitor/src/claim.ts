import type { Queryable } from "@church/shared/db";

/**
 * Due when the last check plus the interval has passed. `last_checked_at` is a
 * `timestamp` holding UTC wall time (the app writes it that way), so it is
 * compared with the database's clock as UTC wall time, not with the node's clock
 * and not through the session time zone.
 */
const DUE = `(last_checked_at IS NULL
   OR last_checked_at + (interval_sec::text || ' seconds')::interval <= (now() AT TIME ZONE 'UTC'))`;
const UNCLAIMED = `(claimed_until IS NULL OR claimed_until < now())`;

/**
 * Take up to `limit` monitors that are due and not already being probed, for
 * `claimSec` seconds, and return their ids. With several nodes each running a
 * worker, a monitor is therefore probed by one of them at a time instead of all.
 *
 * One UPDATE whose outer WHERE repeats the inner SELECT's conditions, so a monitor
 * that another worker claimed between the two is not claimed twice. That runs the
 * same on CockroachDB and YugabyteDB (neither needs SKIP LOCKED). If two workers
 * do collide the database aborts one with a serialization error, which the pool
 * retries (see @church/shared/db retry rules).
 *
 * A worker that dies mid-probe leaves its claim to lapse, so that check is late by
 * at most `claimSec`.
 */
export async function claimDueMonitors(db: Queryable, limit: number, claimSec: number): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `UPDATE monitors
     SET claimed_until = now() + ($2::text || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM monitors
       WHERE enabled AND ${UNCLAIMED} AND ${DUE}
       ORDER BY last_checked_at NULLS FIRST
       LIMIT $1
     )
     AND enabled AND ${UNCLAIMED} AND ${DUE}
     RETURNING id`,
    [limit, String(claimSec)],
  );
  return res.rows.map((r) => r.id);
}

/** Give a claim back without recording a check (the probe could not be completed). */
export async function releaseMonitorClaim(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE monitors SET claimed_until = NULL WHERE id = $1`, [id]);
}
