import { describe, expect, it } from "vitest";
import { AvailabilityStore } from "../src/availability/availability.store";

/** A db whose select chain returns `rows` and counts how many times it is run. */
function fakeDb(rows: unknown[]) {
  let selects = 0;
  const db = {
    select: () => {
      selects++;
      return { from: () => ({ where: () => ({ orderBy: async () => rows }) }) };
    },
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
  };
  return { db, selects: () => selects };
}
const row = { kind: "monitor", ref: "m1", label: "M", hour: new Date("2026-10-15T10:00:00Z"), samples: 3, down: 1 };

describe("AvailabilityStore.hourly read cache", () => {
  it("answers repeated identical reads from one query, whatever order the kinds come in", async () => {
    const f = fakeDb([row]);
    const store = new AvailabilityStore(f.db as never);
    const since = new Date("2026-10-15T00:00:00Z");
    const a = await store.hourly(since, ["monitor", "dns_node"]);
    const b = await store.hourly(since, ["dns_node", "monitor"]);
    expect(f.selects()).toBe(1);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ ref: "m1", samples: 3, down: 1, hour: "2026-10-15T10:00:00.000Z" });
  });

  it("keeps different windows and kind sets apart", async () => {
    const f = fakeDb([row]);
    const store = new AvailabilityStore(f.db as never);
    await store.hourly(new Date("2026-10-15T00:00:00Z"), ["monitor"]);
    await store.hourly(new Date("2026-10-14T00:00:00Z"), ["monitor"]);
    await store.hourly(new Date("2026-10-15T00:00:00Z"));
    expect(f.selects()).toBe(3);
  });

  it("a write on this node is visible to the next read", async () => {
    const f = fakeDb([row]);
    const store = new AvailabilityStore(f.db as never);
    const since = new Date("2026-10-15T00:00:00Z");
    await store.hourly(since);
    await store.record([{ kind: "monitor", ref: "m1", label: "M", down: false }], new Date("2026-10-15T10:00:00Z"));
    await store.hourly(since);
    expect(f.selects()).toBe(2);
  });
});
