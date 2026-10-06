// Steady database traffic through createPool, for tests/db/yb-failover.sh: WORKERS loops, each doing
// one write and one read every ~100 ms; a line per second on stdout; a verdict when told to stop
// (SIGTERM) or when the time is up. Every write that was acknowledged must be in the table at the end.
//   env: DATABASE_URL, SECONDS (default 600), WORKERS (default 4), POOL_NAME
import { randomUUID } from "node:crypto";
import { createPool } from "../../packages/shared/dist/db/index.js";

const seconds = Number(process.env.SECONDS ?? 600);
const workers = Number(process.env.WORKERS ?? 4);
const pool = createPool({ name: process.env.POOL_NAME ?? "load", max: 6, log: (m) => console.log(`  [pool] ${m}`) });
const acked = new Set();
let ok = 0, failed = 0, secOk = 0, secFail = 0, stop = false;
const servers = new Map();
let secServers = new Map();
let lastError = "";

process.on("SIGTERM", () => { stop = true; });
const t0 = Date.now();
const ticker = setInterval(() => {
  const t = Math.round((Date.now() - t0) / 1000);
  const where = [...secServers.entries()].map(([a, n]) => `${a.split("/")[0]}:${n}`).join(",");
  console.log(`t=${t}s ok=${secOk} fail=${secFail} on=${where || "-"}${secFail ? `  last error: ${lastError}` : ""}`);
  secOk = 0; secFail = 0; secServers = new Map();
}, 1000);

await pool.query("CREATE TABLE IF NOT EXISTS smart_test (id uuid PRIMARY KEY, at timestamptz DEFAULT now())");

async function worker() {
  while (!stop && Date.now() - t0 < seconds * 1000) {
    const id = randomUUID();
    try {
      await pool.query("INSERT INTO smart_test (id) VALUES ($1)", [id]);
      acked.add(id);
      const r = await pool.query("SELECT inet_server_addr()::text AS addr");
      const addr = r.rows[0].addr;
      servers.set(addr, (servers.get(addr) ?? 0) + 1);
      secServers.set(addr, (secServers.get(addr) ?? 0) + 1);
      ok++; secOk++;
    } catch (err) {
      failed++; secFail++; lastError = String(err.message).slice(0, 90);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
await Promise.all(Array.from({ length: workers }, worker));
clearInterval(ticker);

let missing = 0;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const res = await pool.query("SELECT id FROM smart_test");
    const have = new Set(res.rows.map((r) => r.id));
    missing = [...acked].filter((id) => !have.has(id)).length;
    break;
  } catch { await new Promise((r) => setTimeout(r, 1000)); }
}
console.log(`RESULT ok=${ok} failed=${failed} acked=${acked.size} missing=${missing} servers=${JSON.stringify(Object.fromEntries(servers))}`);
await pool.end().catch(() => {});
process.exit(missing === 0 ? 0 : 1);
