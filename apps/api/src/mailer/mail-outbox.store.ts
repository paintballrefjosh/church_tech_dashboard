import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { DB_POOL } from "../db/db.module";
import type { MailMessage } from "./mailer.service";

export interface ClaimedMail {
  id: string;
  message: MailMessage;
  /** Including this attempt. */
  attempts: number;
}

/**
 * Storage behind {@link MailQueue}. The database one is the real thing; tests
 * use an in-memory one with the same rules.
 */
export interface MailOutboxStore {
  add(message: MailMessage): Promise<void>;
  /**
   * Take up to `limit` due messages for `claimSec` seconds, counting an attempt
   * on each. Safe to call from several nodes at once: a message is handed to one.
   */
  claim(limit: number, claimSec: number): Promise<ClaimedMail[]>;
  /** The message went out: forget it. */
  sent(id: string): Promise<void>;
  /** The attempt failed; try again in `delaySec`. */
  retryLater(id: string, delaySec: number, error: string): Promise<void>;
  /** Out of attempts: keep it, marked failed, for a while. */
  giveUp(id: string, error: string): Promise<void>;
  /** Drop failed messages older than `maxAgeHours`. */
  prune(maxAgeHours: number): Promise<void>;
}

export const MAIL_OUTBOX_STORE = Symbol("MAIL_OUTBOX_STORE");

/**
 * The claim is one UPDATE whose outer WHERE repeats the inner SELECT's, so a
 * message another node claimed between the two is not claimed twice. That runs
 * the same on CockroachDB and YugabyteDB, which do not both have SKIP LOCKED in
 * every supported version. If two nodes do collide the database aborts one of
 * them with a serialization error; the claim then just comes back empty and the
 * next poll tries again.
 */
@Injectable()
export class DbMailOutboxStore implements MailOutboxStore {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async add(message: MailMessage): Promise<void> {
    await this.pool.query(`INSERT INTO mail_outbox (message) VALUES ($1::jsonb)`, [JSON.stringify(message)]);
  }

  async claim(limit: number, claimSec: number): Promise<ClaimedMail[]> {
    const res = await this.pool.query<{ id: string; message: MailMessage; attempts: number }>(
      `UPDATE mail_outbox
       SET claimed_until = now() + ($2::text || ' seconds')::interval,
           attempts = attempts + 1,
           updated_at = now()
       WHERE id IN (
         SELECT id FROM mail_outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
           AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY next_attempt_at
         LIMIT $1
       )
       AND status = 'pending' AND (claimed_until IS NULL OR claimed_until < now())
       RETURNING id, message, attempts`,
      [limit, String(claimSec)],
    );
    return res.rows.map((r) => ({ id: r.id, message: r.message, attempts: Number(r.attempts) }));
  }

  async sent(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM mail_outbox WHERE id = $1`, [id]);
  }

  async retryLater(id: string, delaySec: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE mail_outbox
       SET claimed_until = NULL, next_attempt_at = now() + ($2::text || ' seconds')::interval,
           last_error = $3, updated_at = now()
       WHERE id = $1`,
      [id, String(delaySec), error.slice(0, 1000)],
    );
  }

  async giveUp(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE mail_outbox SET status = 'failed', claimed_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
      [id, error.slice(0, 1000)],
    );
  }

  async prune(maxAgeHours: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM mail_outbox WHERE status = 'failed' AND updated_at < now() - ($1::text || ' hours')::interval`,
      [String(maxAgeHours)],
    );
  }
}
