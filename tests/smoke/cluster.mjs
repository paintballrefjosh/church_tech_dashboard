/**
 * Admin Cluster page API (GET /api/v1/admin/cluster), run from run.mjs. Works on a single node stack
 * (one node, leading every job) and on a cluster. Read-only apart from checking that the node answering
 * cannot be forgotten.
 */
export async function clusterTests({ test, assert, fetchWithCookies, jar }) {
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  let status;

  await test("cluster: the status lists this node as live, with its build and the jobs it leads", async () => {
    const { res } = await session("/api/v1/admin/cluster");
    assert(res.status === 200, `status ${res.status}`);
    status = await res.json();
    assert(typeof status.self === "string" && status.nodes.length >= 1, `nodes ${JSON.stringify(status.nodes)}`);
    const me = status.nodes.find((n) => n.self);
    assert(me && me.id === status.self && me.live === true && me.ageSec <= 30, `self: ${JSON.stringify(me)}`);
    assert(Array.isArray(status.jobs) && status.jobs.length >= 10, `jobs: ${status.jobs.length}`);
    const names = status.jobs.map((j) => j.name);
    for (const expected of ["backup-scheduler", "cluster-watch", "infra-tick"]) assert(names.includes(expected), `job ${expected} missing from ${names.slice(0, 5)}...`);
    assert(status.jobs.some((j) => j.held && j.node), "no job is led by any node");
    assert(Array.isArray(status.problems) && Array.isArray(status.operations), "shape");
  });

  await test("cluster: the database and object store are probed", async () => {
    assert(status.database.ok === true && /^(CockroachDB|YugabyteDB|Database)/.test(status.database.label) && status.database.latencyMs >= 0, `database: ${JSON.stringify(status.database)}`);
    assert(status.store.ok === true && status.store.bucket && status.store.endpoint, `store: ${JSON.stringify(status.store)}`);
    if (status.store.kind === "garage" && status.store.garage) {
      assert(status.store.garage.nodes.length >= 1 && status.store.garage.nodes.every((n) => typeof n.up === "boolean"), `garage: ${JSON.stringify(status.store.garage)}`);
    }
  });

  await test("cluster: a healthy stack reports no errors", async () => {
    const errors = status.problems.filter((p) => p.severity === "error");
    assert(errors.length === 0, `errors: ${errors.map((e) => e.message).join(" | ")}`);
  });

  await test("cluster: the node answering cannot be forgotten, and an unknown one is a 404", async () => {
    const self = await session(`/api/v1/admin/cluster/nodes/${encodeURIComponent(status.self)}`, { method: "DELETE" });
    assert(self.res.status === 409, `forget self: ${self.res.status}`);
    const none = await session("/api/v1/admin/cluster/nodes/no-such-node", { method: "DELETE" });
    assert(none.res.status === 404, `forget unknown: ${none.res.status}`);
  });
}
