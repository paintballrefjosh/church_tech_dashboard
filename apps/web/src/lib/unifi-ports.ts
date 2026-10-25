import type { FaceItem, FaceState } from "@/components/switch-faceplate";
import type { FaceplateLayout } from "./faceplates/layouts";

/** The fields of a UniFi port-table entry the device page reads; the controller sends many more, varying by firmware. */
export interface UnifiPort {
  port_idx?: number;
  name?: string;
  up?: boolean;
  enable?: boolean;
  /** Mbps; 0 when there is no link. */
  speed?: number;
  full_duplex?: boolean;
  is_uplink?: boolean;
  media?: string;
  poe_enable?: boolean;
  poe_mode?: string;
  /** Watts, as text ("4.21"). */
  poe_power?: string | number;
  poe_class?: string;
  rx_bytes?: number;
  tx_bytes?: number;
}

/** A wired client as the controller lists it: `sw_mac`/`sw_port` say which switch port it is on. */
export interface UnifiWiredClient {
  name?: string;
  hostname?: string;
  ip?: string;
  mac?: string;
  is_wired?: boolean;
  sw_mac?: string;
  sw_port?: number;
}

/** The ports of a device in number order, only those the controller numbered. */
export function sortedPorts(ports: readonly UnifiPort[] | undefined): Array<UnifiPort & { port_idx: number }> {
  return (ports ?? [])
    .filter((p): p is UnifiPort & { port_idx: number } => typeof p.port_idx === "number")
    .sort((a, b) => a.port_idx - b.port_idx);
}

/** A port's state for the picture: switched off by its profile = "shut", link = "up", otherwise "down". */
export function unifiPortState(p: UnifiPort): { state: FaceState; text: string } {
  if (p.enable === false) return { state: "shut", text: "disabled" };
  if (p.up) return { state: "up", text: p.speed ? `up, ${speedText(p.speed)}${p.full_duplex === false ? " half duplex" : ""}` : "up" };
  return { state: "down", text: "no link" };
}

/** 1000 -> "1 Gbps", 100 -> "100 Mbps", 2500 -> "2.5 Gbps". */
export function speedText(mbps: number): string {
  if (mbps >= 1000) return `${Number((mbps / 1000).toFixed(1))} Gbps`;
  return `${mbps} Mbps`;
}

/** "PoE, 4.2 W" while the port is powering something, else undefined (an enabled PoE port with nothing drawing is not powering). */
export function unifiPoeText(p: UnifiPort): string | undefined {
  if (!p.poe_enable) return undefined;
  const w = Number(p.poe_power ?? 0);
  if (!Number.isFinite(w) || w <= 0) return undefined;
  return `PoE, ${w.toFixed(1)} W`;
}

/** UniFi names an unnamed port "Port 7"; only a name someone gave it is a description. */
export function portDescription(p: UnifiPort): string {
  const name = (p.name ?? "").trim();
  return name.toLowerCase() === `port ${p.port_idx}` ? "" : name;
}

/**
 * Which slot of the picture a port sits on. A device profile names its port boxes as the controller numbers the ports
 * ("1" ... "52"); a box named after the port's own name ("SFP+ 1") is accepted too. The built-in drawings are Cisco
 * layouts and never hold a UniFi port.
 */
export function unifiSlotFor(p: UnifiPort & { port_idx: number }, layout: FaceplateLayout): string | null {
  if (layout.source !== "custom") return null;
  const names = layout.names ?? {};
  return names[String(p.port_idx)] ?? (p.name ? names[p.name.trim().toLowerCase()] : undefined) ?? null;
}

/** One FaceItem per numbered port, each slot used once (the lower port number keeps a slot two ports name). */
export function unifiFaceItems(ports: readonly UnifiPort[] | undefined, layout: FaceplateLayout): FaceItem[] {
  const used = new Set<string>();
  return sortedPorts(ports).map((p) => {
    const st = unifiPortState(p);
    let slot = unifiSlotFor(p, layout);
    if (slot !== null && used.has(slot)) slot = null;
    if (slot !== null) used.add(slot);
    return { id: String(p.port_idx), slot, label: String(p.port_idx), state: st.state, stateText: st.text, poe: unifiPoeText(p) };
  });
}

/** The wired clients on each port of the switch `mac`, by port number. */
export function clientsByPort(clients: readonly UnifiWiredClient[], mac: string): Map<number, UnifiWiredClient[]> {
  const want = mac.trim().toLowerCase();
  const out = new Map<number, UnifiWiredClient[]>();
  for (const c of clients) {
    if (c.is_wired === false || typeof c.sw_port !== "number" || (c.sw_mac ?? "").toLowerCase() !== want) continue;
    const list = out.get(c.sw_port);
    if (list) list.push(c);
    else out.set(c.sw_port, [c]);
  }
  return out;
}
