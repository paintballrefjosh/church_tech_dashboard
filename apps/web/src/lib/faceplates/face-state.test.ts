import { describe, expect, it } from "vitest";
import { faceState } from "./face-state";

describe("faceState", () => {
  it("shows a shut down port as shut down whatever the switch reports", () => {
    expect(faceState({ adminEnabled: false, operStatus: "up" }).state).toBe("shut");
    expect(faceState({ adminEnabled: false, operStatus: null }).state).toBe("shut");
  });

  it("shows a connected port as up and an err-disabled one as an error", () => {
    expect(faceState({ adminEnabled: true, operStatus: "up" }).state).toBe("up");
    expect(faceState({ adminEnabled: true, operStatus: "err-disabled" }).state).toBe("error");
  });

  it("shows notconnect and down, the values the poller stores for a port with no link, as enabled with no link", () => {
    expect(faceState({ adminEnabled: true, operStatus: "notconnect" })).toEqual({ state: "down", text: "enabled, no link" });
    expect(faceState({ adminEnabled: true, operStatus: "down" })).toEqual({ state: "down", text: "enabled, no link" });
  });

  it("says not read yet only when the poller has reported nothing for the port", () => {
    expect(faceState({ adminEnabled: true, operStatus: null })).toEqual({ state: "unknown", text: "not read yet" });
  });
});
