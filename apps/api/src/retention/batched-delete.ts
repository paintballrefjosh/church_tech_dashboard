/**
 * Run a bounded delete over and over until it has nothing left to remove, so a backlog is cleared in many small
 * statements instead of one huge transaction (portable SQL has no `DELETE ... LIMIT`; the caller's `deleteBatch`
 * deletes `WHERE pk IN (SELECT pk ... LIMIT n)` and returns how many rows it removed). Stops after `maxBatches`
 * so a single run cannot hold the job for long; the next run carries on. Returns the total removed.
 */
export async function deleteInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  opts: { batchSize?: number; maxBatches?: number; pauseMs?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 1000;
  const maxBatches = opts.maxBatches ?? 200;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const removed = await deleteBatch(batchSize);
    total += removed;
    if (removed < batchSize) break;
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return total;
}
