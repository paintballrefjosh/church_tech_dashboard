import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { DB_POOL } from "../db/db.module";
import { withRev } from "./search-helpers";
import type { SearchDoc } from "./search-types";

/**
 * The shared copy of the documents that do not come from this database (UniFi,
 * DNS), so every node can index them without reaching their source. The node
 * that read the source calls `replace`; every node calls `load`.
 */
export interface LiveSearchStore {
  /**
   * Make the stored set for `kinds` exactly `docs`, writing only rows whose
   * content changed. Returns whether anything changed.
   */
  replace(kinds: string[], docs: SearchDoc[]): Promise<boolean>;
  /** Every stored document of `kinds`. */
  load(kinds: string[]): Promise<SearchDoc[]>;
}

export const LIVE_SEARCH_STORE = Symbol("LIVE_SEARCH_STORE");

const CHUNK = 500;

@Injectable()
export class DbLiveSearchStore implements LiveSearchStore {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async replace(kinds: string[], docs: SearchDoc[]): Promise<boolean> {
    for (const d of docs) {
      if (!kinds.includes(d.kind)) throw new Error(`document ${d.id} has kind ${d.kind}, not one of ${kinds.join(",")}`);
    }
    const want = new Map(docs.map((d) => [d.id, withRev(d)]));
    const res = await this.pool.query<{ doc_id: string; rev: string }>(
      `SELECT doc_id, rev FROM live_search_docs WHERE kind = ANY($1::text[])`,
      [kinds],
    );
    const have = new Map(res.rows.map((r) => [r.doc_id, r.rev]));

    const upserts = [...want.values()].filter((d) => have.get(d.id) !== d.rev);
    const deletes = [...have.keys()].filter((id) => !want.has(id));

    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      for (const d of chunk) {
        const b = params.length;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb)`);
        params.push(d.kind, d.id, d.rev, JSON.stringify(d));
      }
      await this.pool.query(
        `INSERT INTO live_search_docs (kind, doc_id, rev, doc) VALUES ${values.join(", ")}
         ON CONFLICT (kind, doc_id) DO UPDATE SET rev = EXCLUDED.rev, doc = EXCLUDED.doc`,
        params,
      );
    }
    for (let i = 0; i < deletes.length; i += CHUNK) {
      await this.pool.query(`DELETE FROM live_search_docs WHERE kind = ANY($1::text[]) AND doc_id = ANY($2::text[])`, [
        kinds,
        deletes.slice(i, i + CHUNK),
      ]);
    }
    return upserts.length > 0 || deletes.length > 0;
  }

  async load(kinds: string[]): Promise<SearchDoc[]> {
    const res = await this.pool.query<{ doc: SearchDoc }>(
      `SELECT doc FROM live_search_docs WHERE kind = ANY($1::text[]) ORDER BY kind, doc_id`,
      [kinds],
    );
    return res.rows.map((r) => r.doc);
  }
}
