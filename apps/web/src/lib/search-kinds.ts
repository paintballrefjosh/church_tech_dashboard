import {
  Activity,
  BookOpen,
  Boxes,
  Cable,
  Globe,
  Layers,
  LifeBuoy,
  Network,
  Server,
  StickyNote,
  Tag,
  Wifi,
  type LucideIcon,
} from "lucide-react";

/**
 * Every result kind the global search can return. Kept in one place so the
 * search bar and the command palette render identical labels / icons / colours
 * and route the same way. Mirrors `SearchKind` in the API's search.service.ts.
 */
export type SearchKind =
  | "ticket"
  | "note"
  | "wiki"
  | "monitor"
  | "infra_target"
  | "infra_entity"
  | "unifi_device"
  | "unifi_client"
  | "cisco_switch"
  | "cisco_port"
  | "cisco_mac"
  | "cisco_arp"
  | "cisco_vlan";

export interface SearchHit {
  id: string;
  kind: SearchKind;
  resourceId: string;
  title: string;
  body: string;
  extra?: Record<string, unknown>;
  /** Deep link set by the indexer; preferred over the kind-based fallback. */
  url?: string;
  updatedAt: string;
  _formatted?: { title?: string; body?: string };
}

interface KindMeta {
  label: string;
  Icon: LucideIcon;
  /** Tailwind classes for the small pill badge. */
  pill: string;
  /** Tailwind class for the left accent bar. */
  bar: string;
}

// Colour families: content kinds keep their existing hues; infra = indigo,
// UniFi = cyan, Cisco = teal, so a glance tells you which subsystem a hit is in.
// Class strings must be written out in full — Tailwind's JIT can't see values
// assembled by interpolation, so a `bg-${c}-100` template would never generate.
type Colour = "sky" | "amber" | "emerald" | "rose" | "indigo" | "cyan" | "teal";
const PILL: Record<Colour, string> = {
  sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
  cyan: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200",
};
const BAR: Record<Colour, string> = {
  sky: "border-sky-500",
  amber: "border-amber-500",
  emerald: "border-emerald-500",
  rose: "border-rose-500",
  indigo: "border-indigo-500",
  cyan: "border-cyan-500",
  teal: "border-teal-500",
};
function meta(label: string, Icon: LucideIcon, colour: Colour): KindMeta {
  return { label, Icon, pill: PILL[colour], bar: BAR[colour] };
}

export const KIND_META: Record<SearchKind, KindMeta> = {
  ticket: meta("Ticket", LifeBuoy, "sky"),
  wiki: meta("Wiki", BookOpen, "amber"),
  note: meta("Note", StickyNote, "emerald"),
  monitor: meta("Monitor", Activity, "rose"),
  infra_target: meta("Host", Server, "indigo"),
  infra_entity: meta("Infra", Boxes, "indigo"),
  unifi_device: meta("Device", Wifi, "cyan"),
  unifi_client: meta("Client", Wifi, "cyan"),
  cisco_switch: meta("Switch", Network, "teal"),
  cisco_port: meta("Port", Cable, "teal"),
  cisco_mac: meta("MAC", Tag, "teal"),
  cisco_arp: meta("ARP", Globe, "teal"),
  cisco_vlan: meta("VLAN", Layers, "teal"),
};

/** Deep link for a hit: the indexer-provided URL, else a kind-based fallback. */
export function hrefForHit(h: SearchHit): string {
  if (h.url) return h.url;
  switch (h.kind) {
    case "ticket":
      return `/tickets/${h.resourceId}`;
    case "wiki":
      return `/wiki/${h.resourceId}`;
    case "note":
      return `/notes`;
    case "monitor":
      return `/monitoring/${h.resourceId}`;
    case "infra_target":
      return `/monitoring/infra/${h.resourceId}`;
    case "infra_entity":
      return `/monitoring/infra`;
    case "unifi_device":
    case "unifi_client":
      return `/monitoring/network`;
    case "cisco_switch":
    case "cisco_port":
      return `/monitoring/network-cisco`;
    case "cisco_mac":
    case "cisco_arp":
      return `/monitoring/network-cisco/lookup`;
    case "cisco_vlan":
      return `/monitoring/network-cisco/vlans`;
    default:
      return `/`;
  }
}
