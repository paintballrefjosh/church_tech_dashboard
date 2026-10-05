/**
 * Database leases (see docs/multi-node.md). Plain functions over anything with a
 * `query` method, so the API (through its pool), the migrate script and the
 * monitor worker all use the same SQL.
 */
export interface Queryable {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Take the lease if it is free, expired, or already `holder`'s (which renews it).
 * Returns the lease epoch, or null when someone else holds it.
 *
 * One statement, so there is nothing to race: the upsert's WHERE only lets the
 * row change hands when it is ours or has expired, and expiry is judged by the
 * database clock (`now()`), not the caller's. Plain `INSERT ... ON CONFLICT DO
 * UPDATE ... WHERE ... RETURNING` runs the same on CockroachDB and YugabyteDB
 * (checked on Cockroach 24.2 and YugabyteDB 2024.2). `expires_at` is built from a
 * text interval rather than `make_interval`, which is not on every supported
 * version.
 */
export async function acquireLease(
  db: Queryable,
  name: string,
  holder: string,
  ttlSec: number,
): Promise<{ epoch: number } | null> {
  const res = await db.query<{ epoch: number | string }>(
    `INSERT INTO cluster_leases (name, holder, epoch, expires_at)
     VALUES ($1, $2, 1, now() + ($3::text || ' seconds')::interval)
     ON CONFLICT (name) DO UPDATE SET
       epoch = CASE WHEN cluster_leases.holder = EXCLUDED.holder
                    THEN cluster_leases.epoch ELSE cluster_leases.epoch + 1 END,
       holder = EXCLUDED.holder,
       expires_at = EXCLUDED.expires_at
     WHERE cluster_leases.holder = EXCLUDED.holder OR cluster_leases.expires_at < now()
     RETURNING epoch`,
    [name, holder, String(ttlSec)],
  );
  const row = res.rows[0];
  return row ? { epoch: Number(row.epoch) } : null;
}

/** Give a lease up early. A no-op unless `holder` still holds it. */
export async function releaseLease(db: Queryable, name: string, holder: string): Promise<void> {
  await db.query(
    `UPDATE cluster_leases SET expires_at = now() - interval '1 second' WHERE name = $1 AND holder = $2`,
    [name, holder],
  );
}

/** The lease (`mutex:restore`) held for as long as a backup restore is rewriting the database. */
export const RESTORE_LEASE_NAME = "mutex:restore";

/**
 * True while any node is restoring a backup. Writers check it so nothing changes the
 * database under the restore: the API refuses writes, the periodic jobs skip their runs
 * and the monitor worker pauses. Judged by the database clock like every lease.
 */
export async function restoreInProgress(db: Queryable): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 AS held FROM cluster_leases WHERE name = $1 AND expires_at > now() LIMIT 1`,
    [RESTORE_LEASE_NAME],
  );
  return res.rows.length > 0;
}
