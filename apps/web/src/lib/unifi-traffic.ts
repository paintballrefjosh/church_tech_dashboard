/** The byte counters of a UniFi client record (`stat/sta`). Wired clients carry only the `wired-` pair. */
export interface UClientTraffic {
  is_wired?: boolean;
  rx_bytes?: number;
  tx_bytes?: number;
  "wired-rx_bytes"?: number;
  "wired-tx_bytes"?: number;
}

/**
 * What a client downloaded and uploaded.
 *
 * UniFi counts from the access point's (or switch port's) side, not the client's: `tx_bytes` is what the network SENT to the client
 * and `rx_bytes` is what it RECEIVED from it. So a TV streaming shows a huge `tx_bytes` and a tiny `rx_bytes`. Checked on this
 * site against a streaming TV (5.4 GB tx, 54 MB rx) and against the counters of the UniFi switch ports that wired clients sit on
 * (the port's own TX tracks the client's `wired-tx_bytes`). The two names swap, so the page must too.
 */
export function clientTraffic(c: UClientTraffic): { down: number | null; up: number | null } {
  const sent = c.is_wired ? (c["wired-tx_bytes"] ?? c.tx_bytes) : (c.tx_bytes ?? c["wired-tx_bytes"]);
  const received = c.is_wired ? (c["wired-rx_bytes"] ?? c.rx_bytes) : (c.rx_bytes ?? c["wired-rx_bytes"]);
  return {
    down: typeof sent === "number" ? sent : null,
    up: typeof received === "number" ? received : null,
  };
}
