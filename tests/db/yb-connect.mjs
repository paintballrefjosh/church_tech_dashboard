// One connection attempt through createPool, for tests/db/yb-failover.sh: does a process that STARTS
// now (with some hosts dead) get an answer? Prints OK <server address> or FAIL <error>.
import { createPool } from "../../packages/shared/dist/db/index.js";
const pool = createPool({ name: "connect", max: 2, log: () => undefined });
try {
  const r = await pool.query("SELECT inet_server_addr()::text AS addr");
  console.log(`OK ${r.rows[0].addr}`);
  await pool.end();
  process.exit(0);
} catch (err) {
  console.log(`FAIL ${String(err.message).slice(0, 120)}`);
  process.exit(1);
}
