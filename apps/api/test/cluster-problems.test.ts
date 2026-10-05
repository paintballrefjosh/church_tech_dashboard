import { describe, expect, it } from "vitest";
import type { ClusterDatabaseInfo, ClusterJobInfo, ClusterNodeInfo, ClusterStoreInfo } from "@church/shared";
import { findProblems, NODE_STALE_SEC, type ProblemInput } from "../src/cluster-admin/cluster-problems";
import { parseGarageStatus } from "../src/cluster-admin/garage-status";

const node = (id: string, over: Partial<ClusterNodeInfo> = {}): ClusterNodeInfo => ({
  id, role: "full", addr: null, version: "b1", startedAt: "2026-10-05T00:00:00Z", lastSeen: "2026-10-05T00:00:00Z", ageSec: 3, live: true, self: false, ...over,
});
const job = (name: string, nodeId: string | null, held = true): ClusterJobInfo => ({ name, node: nodeId, epoch: 1, expiresInSec: held ? 20 : -5, held });
const db: ClusterDatabaseInfo = { engine: "cockroachdb", label: "CockroachDB v24.2.0", latencyMs: 4, ok: true };
const store: ClusterStoreInfo = { kind: "garage", endpoint: "http://garage:3900", bucket: "church-files", ok: true, latencyMs: 5, garage: { layoutVersion: 2, nodes: [] } };

const base = (over: Partial<ProblemInput> = {}): ProblemInput => ({
  nodes: [node("a"), node("b")],
  registeredJobs: ["x", "y"],
  jobs: [job("x", "a"), job("y", "b")],
  database: db,
  store,
  ...over,
});

describe("cluster problems", () => {
  it("reports nothing for a healthy cluster", () => {
    expect(findProblems(base())).toEqual([]);
  });

  it("reports a node that stopped checking in, but not one that merely missed a beat", () => {
    const quiet = findProblems(base({ nodes: [node("a"), node("b", { live: false, ageSec: NODE_STALE_SEC - 1 })] }));
    expect(quiet).toEqual([]);
    const gone = findProblems(base({ nodes: [node("a"), node("b", { live: false, ageSec: 400, addr: "10.0.0.2" })] }));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ severity: "error" });
    expect(gone[0]!.message).toMatch(/Node b \(10\.0\.0\.2\) stopped checking in 7 minutes ago/);
  });

  it("warns, rather than errors, when live nodes run different builds", () => {
    const p = findProblems(base({ nodes: [node("a", { version: "b1" }), node("b", { version: "b2" })] }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ severity: "warning" });
    expect(p[0]!.message).toMatch(/b1 on a; b2 on b/);
  });

  it("ignores a stopped node's build and a witness's", () => {
    const p = findProblems(base({ nodes: [node("a", { version: "b1" }), node("w", { role: "data", version: null }), node("old", { live: false, ageSec: 10, version: "b0" })] }));
    expect(p).toEqual([]);
  });

  it("reports jobs nobody leads, and says how many", () => {
    const p = findProblems(base({ jobs: [job("x", "a"), job("y", null, false)] }));
    expect(p).toHaveLength(1);
    expect(p[0]!.message).toMatch(/1 background job has no leader right now: y/);
    const many = findProblems(base({ registeredJobs: ["a", "b", "c", "d", "e", "f", "g", "h"], jobs: [] }));
    expect(many[0]!.message).toMatch(/8 background jobs have no leader.*a, b, c, d, e, f, \.\.\./);
  });

  it("does not complain about jobs when no node is up to run them", () => {
    expect(findProblems(base({ nodes: [node("a", { live: false, ageSec: 5 })], jobs: [] }))).toEqual([]);
  });

  it("reports an unreachable database and object store as errors, and a slow database as a warning", () => {
    const p = findProblems(base({ database: { ...db, ok: false, error: "timed out", latencyMs: null }, store: { ...store, ok: false, error: "refused" } }));
    expect(p.map((x) => x.severity)).toEqual(["error", "error"]);
    expect(p[0]!.message).toMatch(/database is not answering.*timed out/);
    expect(findProblems(base({ database: { ...db, latencyMs: 2500 } }))[0]).toMatchObject({ severity: "warning" });
  });

  it("reports object store nodes that are down or draining, errors first", () => {
    const n = (id: string, over = {}) => ({ id, addr: "10.0.0.5:3901", zone: "z", capacityBytes: 1, up: true, lastSeenSecsAgo: null, dataAvailableBytes: null, dataTotalBytes: null, draining: false, ...over });
    const p = findProblems(base({
      store: { ...store, garage: { layoutVersion: 3, nodes: [n("aaaaaaaa11", { draining: true }), n("bbbbbbbb22", { up: false, lastSeenSecsAgo: 300 })] } },
      nodes: [node("a", { version: "x" }), node("b", { version: "y" })],
    }));
    expect(p[0]).toMatchObject({ severity: "error" });
    expect(p[0]!.message).toMatch(/bbbbbbbb.*down: last seen 5 minutes ago/);
    expect(p.at(-1)).toMatchObject({ severity: "warning" });
    expect(p.some((x) => /aaaaaaaa.*drained/.test(x.message))).toBe(true);
  });
});

describe("Garage status parsing", () => {
  it("reads the admin API's answer", () => {
    const s = parseGarageStatus({
      layoutVersion: 4,
      nodes: [
        { id: "abc", addr: "10.0.0.1:3901", isUp: true, lastSeenSecsAgo: null, draining: false, role: { zone: "dc1", capacity: 1000 }, dataPartition: { available: 50, total: 100 } },
        { id: "def", isUp: false, lastSeenSecsAgo: 40, role: null, dataPartition: null },
      ],
    });
    expect(s.layoutVersion).toBe(4);
    expect(s.nodes[0]).toMatchObject({ id: "abc", zone: "dc1", capacityBytes: 1000, up: true, dataAvailableBytes: 50, dataTotalBytes: 100 });
    expect(s.nodes[1]).toMatchObject({ id: "def", addr: null, zone: null, up: false, lastSeenSecsAgo: 40, capacityBytes: null });
  });

  it("copes with an empty or odd answer", () => {
    expect(parseGarageStatus(null)).toEqual({ layoutVersion: 0, nodes: [] });
    expect(parseGarageStatus({ nodes: [{}] }).nodes[0]).toMatchObject({ id: "", up: false });
  });
});
