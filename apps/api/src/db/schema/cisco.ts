import { pgTable, text, integer, boolean, timestamp, uuid, jsonb, index, unique } from "drizzle-orm/pg-core";

/**
 * Cisco switch management — ported from the standalone cisco-switch app. An
 * in-process SSH poller (see cisco/cisco.poller.ts) walks the fleet, stores
 * versioned running-config backups, tracks per-port + per-device configuration
 * drift (desired in `cisco_ports`, observed in `cisco_port_live_state`), and
 * caches L2 data (MAC / ARP / VLAN / neighbors).
 *
 * SSH credentials are AES-256-GCM encrypted at rest (`password_enc`, same
 * primitive as settings/infra) and never returned to the browser.
 */
export const ciscoSwitches = pgTable(
  "cisco_switches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hostname: text("hostname").notNull().unique(),
    ipAddress: text("ip_address").notNull(),
    username: text("username").notNull(),
    passwordEnc: text("password_enc"), // encrypted SSH password; write-only over the API
    model: text("model"),
    location: text("location"),
    // Poller-updated denormalised state.
    reachable: boolean("reachable").notNull().default(true),
    uptime: text("uptime").default("—"),
    lastPolledAt: timestamp("last_polled_at"),
    lastError: text("last_error"),
    configDrift: boolean("config_drift").notNull().default(false),
    checkPortState: boolean("check_port_state").notNull().default(true),
    // Per-category alert toggles (CiscoAlertPrefs): deviceOffline,
    // portStateChange, configChange, uptimeChange. Empty = all off.
    alertPrefs: jsonb("alert_prefs").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ hostIdx: index("cisco_switches_host_idx").on(t.hostname) }),
);

/** Desired port config (source of truth for drift). Seeded on first poll. */
export const ciscoPorts = pgTable(
  "cisco_ports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    portId: text("port_id").notNull(), // e.g. Gi1/0/1
    description: text("description").notNull().default(""),
    adminEnabled: boolean("admin_enabled").notNull().default(true),
    speed: text("speed").notNull().default("1G"),
    duplex: text("duplex").notNull().default("full"),
    mode: text("mode").notNull().default("access"), // access | trunk
    hasSwitchport: boolean("has_switchport").notNull().default(true),
    accessVlan: integer("access_vlan").notNull().default(1),
    trunkNativeVlan: integer("trunk_native_vlan").notNull().default(1),
    trunkAllowedVlans: text("trunk_allowed_vlans").notNull().default("1-4094"),
    neighborHostname: text("neighbor_hostname"),
    neighborIp: text("neighbor_ip"),
    neighborPort: text("neighbor_port"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ uq: unique("cisco_ports_switch_port_uq").on(t.switchId, t.portId) }),
);

/** Observed port state written each poll; joined with cisco_ports for drift. */
export const ciscoPortLiveState = pgTable(
  "cisco_port_live_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    portId: text("port_id").notNull(),
    operStatus: text("oper_status"), // up | down | err-disabled | notconnect
    adminEnabled: boolean("admin_enabled"),
    speed: text("speed"),
    duplex: text("duplex"),
    mode: text("mode"),
    accessVlan: integer("access_vlan"),
    trunkNativeVlan: integer("trunk_native_vlan"),
    trunkAllowedVlans: text("trunk_allowed_vlans"),
    polledAt: timestamp("polled_at"),
  },
  (t) => ({ uq: unique("cisco_live_switch_port_uq").on(t.switchId, t.portId) }),
);

/** Configuration drift log. port_id = '__device__' for switch-level drift. */
export const ciscoDriftEvents = pgTable(
  "cisco_drift_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    portId: text("port_id").notNull(),
    field: text("field").notNull(),
    expected: text("expected"),
    observed: text("observed"),
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => ({ openIdx: index("cisco_drift_open_idx").on(t.switchId, t.resolvedAt) }),
);

/** Versioned running-config backups (incremental via checksum, weekly full). */
export const ciscoConfigBackups = pgTable(
  "cisco_config_backups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    configText: text("config_text").notNull(),
    checksum: text("checksum").notNull(), // sha256 hex of normalised config
    backupType: text("backup_type").notNull().default("incremental"), // full | incremental | manual
    backedUpAt: timestamp("backed_up_at").notNull().defaultNow(),
  },
  (t) => ({ bySwitch: index("cisco_backups_switch_idx").on(t.switchId, t.backedUpAt) }),
);

export const ciscoMacTable = pgTable(
  "cisco_mac_table",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    macAddress: text("mac_address").notNull(),
    vlan: integer("vlan"),
    portId: text("port_id"),
    macType: text("mac_type").default("dynamic"),
    polledAt: timestamp("polled_at"),
  },
  (t) => ({ uq: unique("cisco_mac_uq").on(t.switchId, t.macAddress, t.vlan) }),
);

export const ciscoArpCache = pgTable(
  "cisco_arp_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address").notNull(),
    macAddress: text("mac_address"),
    interface: text("interface"),
    vlan: integer("vlan"),
    vrf: text("vrf").default("default"),
    rdnsName: text("rdns_name"),
    polledAt: timestamp("polled_at"),
  },
  (t) => ({ uq: unique("cisco_arp_uq").on(t.switchId, t.ipAddress) }),
);

export const ciscoVlanDb = pgTable(
  "cisco_vlan_db",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    vlanId: integer("vlan_id").notNull(),
    vlanName: text("vlan_name"),
    vlanStatus: text("vlan_status").default("active"),
    polledAt: timestamp("polled_at"),
  },
  (t) => ({ uq: unique("cisco_vlan_uq").on(t.switchId, t.vlanId) }),
);

/** LLDP/CDP neighbors — used for MAC-lookup uplink exclusion. */
export const ciscoNeighbors = pgTable(
  "cisco_neighbors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    switchId: uuid("switch_id")
      .notNull()
      .references(() => ciscoSwitches.id, { onDelete: "cascade" }),
    localPort: text("local_port").notNull(),
    neighborHostname: text("neighbor_hostname"),
    neighborIp: text("neighbor_ip"),
    neighborPort: text("neighbor_port"),
    protocol: text("protocol"), // lldp | cdp
    neighborType: text("neighbor_type").default("switch"),
    polledAt: timestamp("polled_at"),
  },
  (t) => ({ uq: unique("cisco_neighbor_uq").on(t.switchId, t.localPort, t.neighborHostname) }),
);
