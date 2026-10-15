import { describe, expect, it } from "vitest";
import { deleteInBatches } from "../src/retention/batched-delete";

describe("deleteInBatches", () => {
  const fakeTable = (rows: number) => {
    let left = rows;
    const calls: number[] = [];
    return {
      calls,
      left: () => left,
      batch: async (limit: number) => {
        calls.push(limit);
        const n = Math.min(limit, left);
        left -= n;
        return n;
      },
    };
  };

  it("clears a backlog in bounded statements and stops when a batch comes back short", async () => {
    const t = fakeTable(2500);
    expect(await deleteInBatches(t.batch, { batchSize: 1000 })).toBe(2500);
    expect(t.calls).toEqual([1000, 1000, 1000]);
    expect(t.left()).toBe(0);
  });

  it("does one call when there is nothing to remove", async () => {
    const t = fakeTable(0);
    expect(await deleteInBatches(t.batch)).toBe(0);
    expect(t.calls).toHaveLength(1);
  });

  it("stops after maxBatches so one run cannot hold the job, leaving the rest for the next run", async () => {
    const t = fakeTable(10_000);
    expect(await deleteInBatches(t.batch, { batchSize: 100, maxBatches: 5 })).toBe(500);
    expect(t.left()).toBe(9500);
  });

  it("does not swallow a failure", async () => {
    await expect(deleteInBatches(async () => { throw new Error("db down"); })).rejects.toThrow("db down");
  });
});
