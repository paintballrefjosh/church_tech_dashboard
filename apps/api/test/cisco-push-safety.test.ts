import { describe, expect, it, vi } from "vitest";

const sessions: string[][] = [];
let outputs: string[] = [];

vi.mock("../src/cisco/ssh", async (orig) => ({
  ...(await orig<typeof import("../src/cisco/ssh")>()),
  sshShell: async (_cfg: unknown, cmds: string[]) => {
    sessions.push(cmds);
    return outputs.shift() ?? "";
  },
}));

import { CiscoPoller } from "../src/cisco/cisco.poller";
import type { Mutex } from "../src/cluster/lease.service";

class FreeLeases {
  async acquireMutex(): Promise<Mutex | null> {
    return { lost: false, release: async () => undefined };
  }
}

function poller(snapshot: () => Promise<boolean> = async () => true) {
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "sw", hostname: "sw1" }] }) }) }) };
  const p = new CiscoPoller(db as never, {} as never, {} as never, {} as never, {} as never, new FreeLeases() as never, {} as never);
  (p as unknown as { pinnedConn: () => object }).pinnedConn = () => ({});
  (p as unknown as { snapshot: typeof snapshot }).snapshot = snapshot;
  return p;
}

const change = [{ portId: "Gi1/0/1", field: "description", value: "uplink" }];

describe("a push applies, checks, then saves", () => {
  it("saves to the startup configuration only after the switch accepted every line", async () => {
    sessions.length = 0;
    outputs = ["sw1(config)#description uplink\nsw1#", "Building configuration...\n[OK]\nsw1#"];
    await poller().pushToSwitch("sw", change);
    expect(sessions).toEqual([["configure terminal", "interface Gi1/0/1", "description uplink", "exit", "end"], ["write memory"]]);
  });

  it("does NOT save when the switch refused a line, and says what is and is not in place", async () => {
    sessions.length = 0;
    outputs = ["sw1(config-if)#speed 12345\n% Invalid input detected at '^' marker.\nsw1#"];
    const err = await poller().pushToSwitch("sw", [{ portId: "Gi1/0/1", field: "speed", value: "12345" }]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/refused a command/);
    expect((err as Error).message).toMatch(/NOT saved/);
    expect((err as Error).message).toMatch(/pre-change/);
    expect(sessions).toHaveLength(1); // no "write memory" session
  });

  it("changes nothing when the configuration cannot be read first", async () => {
    sessions.length = 0;
    outputs = [];
    await expect(poller(async () => false).pushToSwitch("sw", change)).rejects.toThrow(/nothing was changed/);
    expect(sessions).toHaveLength(0);
  });

  it("changes nothing when a value is not valid, before even reading the switch", async () => {
    sessions.length = 0;
    const snapshot = vi.fn(async () => true);
    await expect(poller(snapshot).pushToSwitch("sw", [{ portId: "range Gi1/0/1-48", field: "admin_enabled", value: "0" }])).rejects.toThrow(/not an interface name/);
    expect(snapshot).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it("reports changes that are active but could not be saved", async () => {
    sessions.length = 0;
    outputs = ["sw1#", "% Authorization failed.\nsw1#"];
    await expect(poller().pushToSwitch("sw", change)).rejects.toThrow(/active on the switch but it would not save/);
  });
});
