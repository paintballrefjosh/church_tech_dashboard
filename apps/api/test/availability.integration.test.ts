import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { AvailabilityStore } from "../src/availability/availability.store";

/**
 * Real-SQL test of the availability store. Skipped unless TEST_DATABASE_URL points at a migrated
 * scratch database (CockroachDB or YugabyteDB). Empties availability_hourly first.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("availability store against a real database", () => {
  let pool: Pool;
  let store: AvailabilityStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    store = new AvailabilityStore(db);
    await pool.query("DELETE FROM availability_hourly");
  });
  afterAll(async () => {
    await pool?.end();
  });

  const h1 = new Date("2026-10-10T10:00:00Z");
  const h2 = new Date("2026-10-10T11:00:00Z");

  it("adds up samples in the same hour and updates the label", async () => {
    await store.record([{ kind: "monitor", ref: "a", label: "Old", down: true }], h1);
    await store.record([{ kind: "monitor", ref: "a", label: "New", down: false }], h1);
    const rows = (await store.hourly(h1)).filter((r) => r.ref === "a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ kind: "monitor", ref: "a", label: "New", hour: h1.toISOString(), samples: 2, down: 1 });
    expect(typeof rows[0].samples).toBe("number");
    expect(typeof rows[0].down).toBe("number");
  });

  it("keeps different hours and kinds apart, and filters by kind", async () => {
    await store.record(
      [
        { kind: "monitor", ref: "a", label: "New", down: false },
        { kind: "dns_node", ref: "a", label: "ns", down: true },
      ],
      h2,
    );
    const all = (await store.hourly(h1)).filter((r) => r.ref === "a");
    expect(all).toHaveLength(3);
    const dns = await store.hourly(h1, ["dns_node"]);
    expect(dns.map((r) => r.kind)).toEqual(["dns_node"]);
    expect(dns[0].hour).toBe(h2.toISOString());
    expect(new Date(dns[0].hour).getTime()).toBe(h2.getTime());
  });

  it("prunes only rows before the cutoff, in batches", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const samples = Array.from({ length: 1200 }, (_, i) => ({
      kind: "infra_target" as const,
      ref: `old-${i}`,
      label: "x",
      down: false,
    }));
    await store.record(samples, old);
    const removed = await store.prune(new Date("2026-06-01T00:00:00Z"));
    expect(removed).toBe(1200);
    const left = await store.hourly(new Date("2000-01-01T00:00:00Z"));
    expect(left.some((r) => r.ref.startsWith("old-"))).toBe(false);
    expect(left.filter((r) => r.ref === "a")).toHaveLength(3);
  });
});
