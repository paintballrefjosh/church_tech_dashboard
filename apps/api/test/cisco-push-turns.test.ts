import { describe, expect, it, vi } from "vitest";

const sessions: Array<{ cmds: string[]; start: number; end: number }> = [];
let active = 0;
let maxActive = 0;

vi.mock("../src/cisco/ssh", async (orig) => ({
  ...(await orig<typeof import("../src/cisco/ssh")>()),
  sshShell: async (_cfg: unknown, cmds: string[]) => {
    const entry = { cmds, start: Date.now(), end: 0 };
    sessions.push(entry);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    active--;
    entry.end = Date.now();
    return "";
  },
}));

import { CiscoPoller } from "../src/cisco/cisco.poller";
import type { Mutex } from "../src/cluster/lease.service";

/** In-memory stand-in for the database mutex: acquire fails while the name is held. */
class FakeLeases {
  private held = new Set<string>();
  async acquireMutex(name: string): Promise<Mutex | null> {
    if (this.held.has(name)) return null;
    this.held.add(name);
    return { lost: false, release: async () => void this.held.delete(name) };
  }
}

function poller() {
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "sw" }] }) }) }) };
  const p = new CiscoPoller(db as never, {} as never, {} as never, {} as never, {} as never, new FakeLeases() as never, {} as never);
  (p as unknown as { pinnedConn: () => object }).pinnedConn = () => ({});
  return p;
}

describe("pushes to switches", () => {
  it("take turns on the same switch and overlap across switches", async () => {
    const p = poller();
    sessions.length = 0;
    maxActive = 0;
    const speed = (port: string) => [{ portId: port, field: "speed", value: "1000" }];

    await Promise.all([p.pushToSwitch("sw-a", speed("Gi1/0/1")), p.pushToSwitch("sw-a", speed("Gi1/0/2"))]);
    expect(sessions).toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(sessions[1]!.start).toBeGreaterThanOrEqual(sessions[0]!.end);

    sessions.length = 0;
    maxActive = 0;
    await Promise.all([p.pushToSwitch("sw-a", speed("Gi1/0/1")), p.pushToSwitch("sw-b", speed("Gi1/0/1"))]);
    expect(maxActive).toBe(2);
  });

  it("sends the speed as the switch's number and refuses a line break", async () => {
    const p = poller();
    sessions.length = 0;
    await p.pushToSwitch("sw-a", [
      { portId: "Gi1/0/1", field: "speed", value: "1G" },
      { portId: "Gi1/0/1", field: "duplex", value: "full" },
    ]);
    expect(sessions[0]!.cmds).toEqual(["configure terminal", "interface Gi1/0/1", "speed 1000", "duplex full", "exit", "end", "write memory"]);

    sessions.length = 0;
    await expect(p.pushToSwitch("sw-a", [{ portId: "Gi1/0/1", field: "description", value: "x\nreload" }])).rejects.toThrow(/control characters/);
    expect(sessions).toHaveLength(0);
  });
});
