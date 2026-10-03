import { pgTable, text, integer, boolean, timestamp, uuid, jsonb, index, unique } from "drizzle-orm/pg-core";

/**
 * IPAM — a lightweight IP-address manager for the monitoring module's IPAM tab.
 *
 * `ipam_subnets` holds the CIDR ranges to sweep. Rows come from three places
 * (`source`): `manual` (an operator adds a range), `cisco` (derived from a
 * switch's SVI/`ip address` lines in the stored running-config, or inferred
 * from its ARP cache), and `unifi` (the controller's `rest/networkconf`). The
 * scanner (ipam/ipam.scanner.ts) sweeps every `scan_enabled` subnet on the
 * interval configured in settings.
 *
 * `ipam_hosts` is the discovered inventory: one row per IP we've ever seen up
 * in a subnet. A host that stops answering is kept with `is_up=false` (so its
 * history/last-seen survives) rather than deleted — rows are only removed when
 * their subnet is. Names come from reverse DNS, NetBIOS (nbstat) and the UniFi
 * controller's client list (DHCP hostname / operator alias) as each is
 * available; the MAC is joined in from the Cisco ARP cache / UniFi client list
 * at scan time. (Bonjour/mDNS was dropped: it is link-local only and the
 * scanner runs off-subnet, so responders never answer it — UniFi already holds
 * the friendly names it would have surfaced.)
 */
export const ipamSubnets = pgTable(
  "ipam_subnets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cidr: text("cidr").notNull().unique(), // e.g. "10.0.10.0/24"
    label: text("label").notNull().default(""),
    // True while the label is free to be refreshed from the source system
    // (UniFi network name / Cisco VLAN name) by the periodic label sync;
    // flipped to false the moment an operator edits the label by hand.
    labelAuto: boolean("label_auto").notNull().default(true),
    vlanId: integer("vlan_id"),
    gateway: text("gateway"),
    // manual | cisco | unifi — where the range was discovered.
    source: text("source").notNull().default("manual"),
    // Free-form origin hint (switch hostname, UniFi network name, …).
    sourceDetail: text("source_detail"),
    scanEnabled: boolean("scan_enabled").notNull().default(true),
    // Poller-updated sweep state.
    lastScanStartedAt: timestamp("last_scan_started_at"),
    lastScanFinishedAt: timestamp("last_scan_finished_at"),
    lastError: text("last_error"),
    hostCount: integer("host_count").notNull().default(0),
    aliveCount: integer("alive_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ cidrIdx: index("ipam_subnets_cidr_idx").on(t.cidr) }),
);

export const ipamHosts = pgTable(
  "ipam_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subnetId: uuid("subnet_id")
      .notNull()
      .references(() => ipamSubnets.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address").notNull(),
    macAddress: text("mac_address"),
    hostname: text("hostname"), // reverse DNS (PTR)
    netbiosName: text("netbios_name"),
    unifiName: text("unifi_name"), // UniFi client alias (name) or DHCP hostname
    isUp: boolean("is_up").notNull().default(false),
    // How the host answered this scan: "icmp" | "tcp" | null (down).
    respondedVia: text("responded_via"),
    // TCP ports found open during a TCP-fallback probe (numbers).
    openPorts: jsonb("open_ports").notNull().default([]),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at"), // last time observed up
    lastScanAt: timestamp("last_scan_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uq: unique("ipam_hosts_subnet_ip_uq").on(t.subnetId, t.ipAddress),
    ipIdx: index("ipam_hosts_ip_idx").on(t.ipAddress),
  }),
);
