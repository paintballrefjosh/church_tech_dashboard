import { describe, expect, it } from "vitest";
import { clientTraffic } from "./unifi-traffic";

describe("clientTraffic", () => {
  it("reads a streaming TV as a big download: UniFi's tx is what the network sent to the client", () => {
    expect(clientTraffic({ is_wired: false, rx_bytes: 54_520_365, tx_bytes: 5_452_549_349 })).toEqual({
      down: 5_452_549_349,
      up: 54_520_365,
    });
  });

  it("uses the wired- counters for a wired client, which has no plain pair", () => {
    expect(clientTraffic({ is_wired: true, "wired-rx_bytes": 5_000_000, "wired-tx_bytes": 89_000_000 })).toEqual({
      down: 89_000_000,
      up: 5_000_000,
    });
  });

  it("keeps a zero as zero and a missing counter as unknown", () => {
    expect(clientTraffic({ is_wired: true, "wired-rx_bytes": 0, "wired-tx_bytes": 0 })).toEqual({ down: 0, up: 0 });
    expect(clientTraffic({ is_wired: true })).toEqual({ down: null, up: null });
  });
});
