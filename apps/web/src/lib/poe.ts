import type { CiscoPortPoe } from "@church/shared";

/** True while the switch is powering a device on this port. */
export function poeProviding(poe: CiscoPortPoe | null | undefined): boolean {
  return poe?.status === "on";
}

export function formatWatts(mw: number | null): string {
  return mw === null ? "—" : `${(mw / 1000).toFixed(1)} W`;
}

/**
 * The PoE kind of a powered device. The IEEE class says what the device asked for (0-3 af, 4 at, 5-8 bt); a device can also
 * be given more than its class implies once it negotiates over LLDP, so the power set aside counts too and the larger wins.
 */
export function poeKind(ieeeClass: number | null, allocatedMw: number | null): string {
  const byClass = ieeeClass === null ? 0 : ieeeClass <= 3 ? 1 : ieeeClass === 4 ? 2 : 3;
  const byPower = allocatedMw === null || allocatedMw <= 0 ? 0 : allocatedMw > 30_000 ? 3 : allocatedMw > 15_400 ? 2 : 1;
  const rank = Math.max(byClass, byPower);
  if (rank <= 1) return "PoE (802.3af)";
  if (rank === 2) return "PoE+ (802.3at)";
  if (ieeeClass !== null && ieeeClass >= 7) return "PoE++ (802.3bt type 4)";
  if (ieeeClass !== null && ieeeClass >= 5) return "PoE++ (802.3bt type 3)";
  return "PoE++ (802.3bt)";
}

/** The name alone, for the short places: "PoE", "PoE+", "PoE++". */
export function poeShortName(ieeeClass: number | null, allocatedMw: number | null): string {
  return poeKind(ieeeClass, allocatedMw).split(" ")[0]!;
}

const STATUS_WORDS: Record<string, string> = {
  off: "no device powered",
  disabled: "turned off on this port",
  faulty: "fault on this port",
  "power-deny": "power denied (the switch's budget is used up)",
};

/** Rows for the port's hover window; empty for a port with no PoE reading. */
export function poeRows(poe: CiscoPortPoe | null | undefined): Array<[string, string]> {
  if (!poe) return [];
  if (!poeProviding(poe)) return [["PoE", STATUS_WORDS[poe.status] ?? poe.status]];
  const rows: Array<[string, string]> = [
    ["PoE", `${poeKind(poe.ieeeClass, poe.allocatedMw)}${poe.ieeeClass !== null ? ` · class ${poe.ieeeClass}` : ""}`],
    [
      "Power",
      poe.measuredMw !== null
        ? `${formatWatts(poe.measuredMw)} in use · ${formatWatts(poe.allocatedMw)} set aside`
        : `${formatWatts(poe.allocatedMw)} set aside`,
    ],
  ];
  if (poe.device) rows.push(["Powered device", poe.device]);
  return rows;
}

/** A few words for a screen reader and the strip: "PoE+, 8.1 W". */
export function poeSummary(poe: CiscoPortPoe): string {
  const watts = poe.measuredMw ?? poe.allocatedMw;
  return `${poeShortName(poe.ieeeClass, poe.allocatedMw)}${watts !== null ? `, ${formatWatts(watts)}` : ""}`;
}

/** What the powered ports of a switch deliver together ("143.7 W"), or null when nothing is being powered. */
export function poeInUse(ports: Array<{ poe: CiscoPortPoe | null | undefined }>): string | null {
  let total = 0;
  let any = false;
  for (const { poe } of ports) {
    if (!poe || !poeProviding(poe)) continue;
    const mw = poe.measuredMw ?? poe.allocatedMw;
    if (mw === null) continue;
    total += mw;
    any = true;
  }
  return any ? formatWatts(total) : null;
}
