import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { DB_POOL } from "../db/db.module";

/** One row of `realtime_events`. */
export interface BusRow {
  id: string;
  originNode: string;
  seq: number;
  room: string;
  event: string;
  /** Null when `ref` names a live snapshot holding the payload. */
  payload: unknown | null;
  ref: string | null;
  ts: Date;
}

export type NewBusRow = Omit<BusRow, "ts">;

/**
 * Storage behind {@link ClusterBus}. The database one is the real thing; tests
 * use an in-memory one. Every time here is the database's clock.
 */
export interface BusStore {
  now(): Promise<Date>;
  /** Insert rows; the database assigns `ts` (one value for the whole batch). */
  insert(rows: NewBusRow[]): Promise<void>;
  /** Rows newer than `since` from any origin but `excludeOrigin`, ordered (ts, origin, seq). */
  fetch(since: Date, excludeOrigin: string, limit: number): Promise<BusRow[]>;
  /** Replace this node's presence rows with exactly `rooms`. */
  writePresence(nodeId: string, rooms: Map<string, number>): Promise<void>;
  /** Socket counts per room on every other node that refreshed within `maxAgeSec`. */
  readPresence(excludeNodeId: string, maxAgeSec: number): Promise<Map<string, number>>;
  readSnapshot(kind: string): Promise<unknown | null>;
  writeSnapshot(kind: string, payload: unknown): Promise<void>;
  prune(maxAgeSec: number): Promise<void>;
}

export const BUS_STORE = Symbol("BUS_STORE");

/**
 * Timestamps cross this boundary as epoch milliseconds, computed in SQL.
 * Drizzle's `drizzle()` replaces pg's timestamp parsers process-wide with ones
 * that return the raw string, so a raw `pool.query` in this app gets strings,
 * not Dates, for timestamp columns; milliseconds do not depend on that.
 */
@Injectable()
export class DbBusStore implements BusStore {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async now(): Promise<Date> {
    const res = await this.pool.query<{ ms: number }>("SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms");
    return new Date(Number(res.rows[0]!.ms));
  }

  async insert(rows: NewBusRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const r of rows) {
      const b = params.length;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7})`);
      params.push(r.id, r.originNode, r.seq, r.room, r.event, r.payload === null ? null : JSON.stringify(r.payload), r.ref);
    }
    await this.pool.query(
      `INSERT INTO realtime_events (id, origin_node, seq, room, event, payload, ref) VALUES ${values.join(", ")}`,
      params,
    );
  }

  async fetch(since: Date, excludeOrigin: string, limit: number): Promise<BusRow[]> {
    const res = await this.pool.query<{
      id: string;
      origin_node: string;
      seq: string | number;
      room: string;
      event: string;
      payload: unknown | null;
      ref: string | null;
      ts_ms: number;
    }>(
      `SELECT id, origin_node, seq, room, event, payload, ref, (extract(epoch FROM ts) * 1000)::float8 AS ts_ms
       FROM realtime_events
       WHERE ts > to_timestamp($1::float8 / 1000) AND origin_node <> $2
       ORDER BY ts, origin_node, seq
       LIMIT $3`,
      [since.getTime(), excludeOrigin, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      originNode: r.origin_node,
      seq: Number(r.seq),
      room: r.room,
      event: r.event,
      payload: r.payload,
      ref: r.ref,
      ts: new Date(Number(r.ts_ms)),
    }));
  }

  async writePresence(nodeId: string, rooms: Map<string, number>): Promise<void> {
    if (rooms.size > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      for (const [room, n] of rooms) {
        const b = params.length;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
        params.push(nodeId, room, n);
      }
      await this.pool.query(
        `INSERT INTO realtime_presence (node_id, room, sockets) VALUES ${values.join(", ")}
         ON CONFLICT (node_id, room) DO UPDATE SET sockets = EXCLUDED.sockets, updated_at = now()`,
        params,
      );
    }
    await this.pool.query(`DELETE FROM realtime_presence WHERE node_id = $1 AND room <> ALL($2::text[])`, [
      nodeId,
      [...rooms.keys()],
    ]);
  }

  async readPresence(excludeNodeId: string, maxAgeSec: number): Promise<Map<string, number>> {
    const res = await this.pool.query<{ room: string; n: string | number }>(
      `SELECT room, sum(sockets) AS n FROM realtime_presence
       WHERE node_id <> $1 AND updated_at > now() - ($2::text || ' seconds')::interval
       GROUP BY room`,
      [excludeNodeId, String(maxAgeSec)],
    );
    return new Map(res.rows.map((r) => [r.room, Number(r.n)]));
  }

  async readSnapshot(kind: string): Promise<unknown | null> {
    const res = await this.pool.query<{ payload: unknown }>(`SELECT payload FROM live_snapshots WHERE kind = $1`, [kind]);
    return res.rows[0]?.payload ?? null;
  }

  async writeSnapshot(kind: string, payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO live_snapshots (kind, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (kind) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [kind, JSON.stringify(payload)],
    );
  }

  async prune(maxAgeSec: number): Promise<void> {
    const age = String(maxAgeSec);
    await this.pool.query(`DELETE FROM realtime_events WHERE ts < now() - ($1::text || ' seconds')::interval`, [age]);
    await this.pool.query(`DELETE FROM realtime_presence WHERE updated_at < now() - ($1::text || ' seconds')::interval`, [age]);
  }
}
