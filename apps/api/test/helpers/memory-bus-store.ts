import type { BusRow, BusStore, NewBusRow } from "../../src/cluster/bus.store";

/**
 * In-memory stand-in for the realtime tables. Like the database it stamps rows
 * with its own clock and gives each insert call a new, later timestamp.
 */
export class MemoryBusStore implements BusStore {
  rows: BusRow[] = [];
  presence = new Map<string, { rooms: Map<string, number>; at: number }>();
  snapshots = new Map<string, unknown>();
  down = false;
  private tick = 0;

  private stamp(): Date {
    return new Date(Date.now() + this.tick++);
  }
  async now(): Promise<Date> {
    if (this.down) throw new Error("db down");
    return new Date(Date.now() + this.tick);
  }
  async insert(rows: NewBusRow[]): Promise<void> {
    if (this.down) throw new Error("db down");
    const ts = this.stamp();
    for (const r of rows) this.rows.push({ ...r, ts });
  }
  /** Insert a row with an explicit timestamp, to model a commit that lands late. */
  insertAt(row: NewBusRow, ts: Date): void {
    this.rows.push({ ...row, ts });
  }
  async fetch(since: Date, excludeOrigin: string, limit: number): Promise<BusRow[]> {
    if (this.down) throw new Error("db down");
    return this.rows
      .filter((r) => r.ts > since && r.originNode !== excludeOrigin)
      .sort((a, b) => a.ts.getTime() - b.ts.getTime() || (a.originNode < b.originNode ? -1 : a.originNode > b.originNode ? 1 : 0) || a.seq - b.seq)
      .slice(0, limit);
  }
  async writePresence(nodeId: string, rooms: Map<string, number>): Promise<void> {
    if (this.down) throw new Error("db down");
    if (rooms.size === 0) this.presence.delete(nodeId);
    else this.presence.set(nodeId, { rooms: new Map(rooms), at: Date.now() });
  }
  async readPresence(excludeNodeId: string, maxAgeSec: number): Promise<Map<string, number>> {
    if (this.down) throw new Error("db down");
    const out = new Map<string, number>();
    for (const [node, p] of this.presence) {
      if (node === excludeNodeId || Date.now() - p.at > maxAgeSec * 1000) continue;
      for (const [room, n] of p.rooms) out.set(room, (out.get(room) ?? 0) + n);
    }
    return out;
  }
  async readSnapshot(kind: string) {
    return this.snapshots.get(kind) ?? null;
  }
  async writeSnapshot(kind: string, payload: unknown) {
    this.snapshots.set(kind, payload);
  }
  async prune(maxAgeSec: number): Promise<void> {
    this.rows = this.rows.filter((r) => Date.now() - r.ts.getTime() <= maxAgeSec * 1000);
  }
}
