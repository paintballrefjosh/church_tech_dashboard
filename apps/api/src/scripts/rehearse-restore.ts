/* eslint-disable no-console */
import { createReadStream } from "node:fs";
import { createPool } from "@church/shared/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { databaseUrl } from "../db/connection";
import { gunzipped } from "../backup/archive";
import { computeDiff } from "../backup/backup-diff";
import { S3ObjectStore } from "../backup/object-store";
import { secretFingerprint } from "../backup/backup.service";

/**
 * Helper for tests/cluster/verify-restore.sh, run inside a node of the THROWAWAY cluster (never the live stack):
 *
 *   node dist/scripts/rehearse-restore.js diff <archive.tar.gz>   compare the database with a backup file, exit 1 unless identical
 *   node dist/scripts/rehearse-restore.js operation <id>          print a backup operation row (status, error, result) as JSON
 *
 * It reads only. `diff` is the app's own comparison (the one behind the Restore tab) run straight against the database, so
 * the proof that a restore put everything back does not depend on being able to sign in afterwards: a restore of a backup
 * made elsewhere replaces the very account that asked for it.
 */
async function main(): Promise<number> {
  const [command, arg] = process.argv.slice(2);
  if ((command !== "diff" && command !== "operation") || !arg) {
    console.error("usage: rehearse-restore.js diff <archive.tar.gz> | operation <id>");
    return 2;
  }
  const pool = createPool({ name: "rehearse-restore", url: databaseUrl(), max: 4 });
  const db = drizzle(pool, { schema });
  try {
    if (command === "operation") {
      const [op] = await db.select().from(schema.backupOperations).where(eq(schema.backupOperations.id, arg)).limit(1);
      console.log(JSON.stringify(op ? { status: op.status, phase: op.phase, error: op.error, result: op.result } : { status: "missing" }));
      return 0;
    }
    const out = await computeDiff(
      { db, store: new S3ObjectStore() },
      {
        backup: { id: "rehearsal", name: arg, createdAt: new Date().toISOString() },
        archive: () => gunzipped(createReadStream(arg)),
        secretFingerprint: secretFingerprint(),
        userId: null,
        scope: null,
      },
    );
    const r = out.report;
    const differing = r.groups.flatMap((g) => g.tables).filter((t) => t.added + t.removed + t.changed > 0).map((t) => ({ table: t.table, added: t.added, removed: t.removed, changed: t.changed }));
    const files = r.files ? { added: r.files.added, removed: r.files.removed } : null;
    const identical = differing.length === 0 && r.totals.added + r.totals.removed + r.totals.changed === 0 && (!files || files.added + files.removed === 0);
    console.log(
      JSON.stringify({
        identical,
        compatible: r.compatibility.ok,
        errors: r.compatibility.errors,
        warnings: r.compatibility.warnings,
        totals: r.totals,
        tablesCompared: r.identicalTables.length + differing.length,
        differing,
        files,
      }),
    );
    return identical && r.compatibility.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
