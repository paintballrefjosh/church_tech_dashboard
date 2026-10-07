/**
 * What a backup does with each table. EVERY table in the schema must have an entry here
 * (a unit test fails when one is added without a decision), because "do we back this up,
 * and what does a restore do to it" is not something to leave to a default.
 *
 *  - `data`  is saved in every backup and brought back by a restore: rows that changed are
 *            put back as they were, rows added since are deleted, rows deleted since are
 *            re-created.
 *  - `skip`  is not saved and a restore leaves it alone: history and logs that must not be
 *            rewound (the audit log), data the app rebuilds by itself (polled caches,
 *            metrics), per-node runtime state (leases, events, queues) and the backup
 *            tables themselves.
 *
 * `volatile` columns hold values that pollers and background jobs rewrite constantly (a
 * monitor's last check time, a printer's toner level). They are saved, but a comparison
 * ignores them and a restore leaves a live row's values alone: otherwise every diff would
 * be full of "changes" nobody made, and a restore would rewind live device state.
 * `sensitive` columns are never shown in a comparison, only that they differ.
 * `label` names the columns that describe a row to a person.
 */
export type TablePolicy = "data" | "skip";

export interface TableInfo {
  policy: TablePolicy;
  /** Section of the comparison report. */
  group: string;
  /** What a person calls this table. */
  title: string;
  label?: string[];
  volatile?: string[];
  sensitive?: string[];
  /** Why a `skip` table is skipped. */
  reason?: string;
  /**
   * Columns filled from a sequence. A restore writes explicit values, which does not move the
   * sequence, so afterwards it is moved past the largest value or the next new row would reuse a number.
   */
  sequences?: Array<{ column: string; sequence: string }>;
}

const PEOPLE = "People and access";
const SETTINGS = "Settings";
const HELPDESK = "Helpdesk";
const WIKI = "Wiki";
const NOTES = "Notes";
const CHECKLISTS = "Checklists";
const MONITORING = "Monitoring";
const PRINTERS = "Printers";
const FILES = "Files";
const OTHER = "Other";

const runtime = (title: string, reason: string): TableInfo => ({ policy: "skip", group: OTHER, title, reason });
const rebuilt = (title: string): TableInfo => ({ policy: "skip", group: MONITORING, title, reason: "Rebuilt by the pollers." });

export const TABLE_REGISTRY: Record<string, TableInfo> = {
  // ---- people and access ----
  users: { policy: "data", group: PEOPLE, title: "Users", label: ["name", "email"] },
  accounts: { policy: "data", group: PEOPLE, title: "Linked sign-in accounts", label: ["provider"], sensitive: ["refresh_token", "access_token", "id_token", "session_state"] },
  credentials: { policy: "data", group: PEOPLE, title: "Local passwords", sensitive: ["password_hash"] },
  totp_secrets: { policy: "data", group: PEOPLE, title: "Two-factor secrets", sensitive: ["secret", "recovery_codes"] },
  groups: { policy: "data", group: PEOPLE, title: "Groups", label: ["name"] },
  group_memberships: { policy: "data", group: PEOPLE, title: "Group memberships" },
  group_module_access: { policy: "data", group: PEOPLE, title: "Group access to modules", label: ["module_key", "tier"] },
  api_tokens: { policy: "data", group: PEOPLE, title: "API tokens", label: ["name"], sensitive: ["token_hash"], volatile: ["last_used_at", "last_used_ip"] },
  // The old role model: never read, kept so a restore of an old backup stays consistent.
  roles: { policy: "data", group: PEOPLE, title: "Roles (legacy)", label: ["key"] },
  permissions: { policy: "data", group: PEOPLE, title: "Permissions (legacy)", label: ["key"] },
  role_permissions: { policy: "data", group: PEOPLE, title: "Role permissions (legacy)" },
  group_permissions: { policy: "data", group: PEOPLE, title: "Group permissions (legacy)" },
  user_roles: { policy: "data", group: PEOPLE, title: "User roles (legacy)" },
  auth_tokens: runtime("Invitation and reset tokens", "Short-lived one-time links; they must not come back from the past."),
  sessions: runtime("Sessions", "Sessions are cookies signed with AUTH_SECRET; this table is not used."),
  verificationTokens: runtime("Verification tokens", "Short-lived one-time tokens."),

  // ---- settings ----
  settings: { policy: "data", group: SETTINGS, title: "Settings", label: ["key"] },
  dashboard_layouts: { policy: "data", group: SETTINGS, title: "Dashboard layouts" },
  saved_views: { policy: "data", group: SETTINGS, title: "Saved views", label: ["name"] },
  notification_prefs: { policy: "data", group: SETTINGS, title: "Notification preferences", label: ["kind"] },
  planning_center_links: { policy: "data", group: SETTINGS, title: "Planning Center links", label: ["pc_email"] },

  // ---- helpdesk ----
  tickets: { policy: "data", group: HELPDESK, title: "Tickets", label: ["number", "title"], sequences: [{ column: "number", sequence: "tickets_number_seq" }] },
  ticket_comments: { policy: "data", group: HELPDESK, title: "Ticket comments", label: ["body"] },
  ticket_categories: { policy: "data", group: HELPDESK, title: "Ticket categories", label: ["name"] },
  ticket_category_assignments: { policy: "data", group: HELPDESK, title: "Ticket category assignments" },

  // ---- wiki ----
  wiki_pages: { policy: "data", group: WIKI, title: "Wiki pages", label: ["title"] },
  wiki_folders: { policy: "data", group: WIKI, title: "Wiki folders", label: ["name"] },
  wiki_page_acl: { policy: "data", group: WIKI, title: "Wiki page access" },
  wiki_revisions: { policy: "data", group: WIKI, title: "Wiki page history", label: ["title", "summary"] },

  // ---- notes, tags, activity ----
  notes: { policy: "data", group: NOTES, title: "Notes", label: ["title"] },
  tags: { policy: "data", group: NOTES, title: "Tags", label: ["name"] },
  tag_assignments: { policy: "data", group: NOTES, title: "Tag assignments" },
  notifications: { policy: "data", group: NOTES, title: "Notifications", label: ["title"] },
  activity_events: { policy: "data", group: NOTES, title: "Activity feed", label: ["title", "action"] },

  // ---- files ----
  attachments: { policy: "data", group: FILES, title: "Attachments", label: ["filename"] },

  // ---- checklists ----
  checklist_stations: { policy: "data", group: CHECKLISTS, title: "Checklist stations", label: ["name"] },
  checklist_templates: { policy: "data", group: CHECKLISTS, title: "Checklist templates", label: ["name"] },
  checklist_template_tasks: { policy: "data", group: CHECKLISTS, title: "Template tasks", label: ["title"] },
  checklist_services: { policy: "data", group: CHECKLISTS, title: "Recurring services", label: ["name"] },
  checklist_service_positions: { policy: "data", group: CHECKLISTS, title: "Service positions", label: ["position_name"] },
  checklist_service_position_defaults: { policy: "data", group: CHECKLISTS, title: "Default position volunteers" },
  checklist_service_templates: { policy: "data", group: CHECKLISTS, title: "Service templates" },
  checklist_events: { policy: "data", group: CHECKLISTS, title: "Checklist events", label: ["name", "occurrence_date"] },
  checklist_event_tasks: { policy: "data", group: CHECKLISTS, title: "Event tasks", label: ["title"] },
  checklist_event_assignees: { policy: "data", group: CHECKLISTS, title: "Event volunteers", label: ["position_name"] },

  // ---- monitoring ----
  monitors: {
    policy: "data", group: MONITORING, title: "Service monitors", label: ["name"],
    volatile: ["status", "last_checked_at", "claimed_until", "last_latency_ms", "consecutive_fails", "consecutive_oks"],
  },
  monitor_incidents: { policy: "data", group: MONITORING, title: "Incidents", label: ["reason", "detail"] },
  infra_targets: {
    policy: "data", group: MONITORING, title: "Infrastructure hosts", label: ["name"],
    volatile: ["status", "last_polled_at", "last_error", "last_sample", "alert_state"],
  },
  infra_target_credentials: { policy: "data", group: MONITORING, title: "Infrastructure credentials", sensitive: ["secret_enc", "extra_enc"] },
  infra_entities: {
    policy: "data", group: MONITORING, title: "Infrastructure entities", label: ["name"],
    volatile: ["status", "health", "state", "present", "last_seen_at"],
  },
  infra_update_runs: { policy: "data", group: MONITORING, title: "Update runs", label: ["status"] },
  monitor_checks: rebuilt("Monitor check history"),
  infra_metric_samples: rebuilt("Infrastructure metric samples"),
  infra_metric_rollups: rebuilt("Infrastructure metric rollups"),

  // ---- printers, UPS, Cisco, IPAM (the Monitoring menu) ----
  printers: {
    policy: "data", group: PRINTERS, title: "Printers", label: ["name"],
    sensitive: ["snmp_community", "fiery_api_key"],
    volatile: ["last_status", "last_checked_at", "last_error", "supplies", "inputs", "alerts", "fiery_queue_depth"],
  },
  ups_devices: {
    policy: "data", group: MONITORING, title: "UPS devices", label: ["name"], sensitive: ["snmp_community"],
    volatile: ["last_status", "last_checked_at", "last_error", "battery_pct", "runtime_min", "load_pct", "input_voltage", "output_voltage", "battery_state", "output_source"],
  },
  cisco_switches: {
    policy: "data", group: MONITORING, title: "Cisco switches", label: ["hostname"], sensitive: ["password_enc"],
    volatile: ["reachable", "uptime", "last_polled_at", "last_error", "config_drift"],
  },
  cisco_ports: {
    policy: "data", group: MONITORING, title: "Cisco ports", label: ["port_id", "description"],
    volatile: ["neighbor_hostname", "neighbor_ip", "neighbor_port"],
  },
  cisco_config_backups: { policy: "data", group: MONITORING, title: "Cisco configuration backups", label: ["backup_type", "backed_up_at"] },
  cisco_arp_cache: rebuilt("Cisco ARP cache"),
  cisco_mac_table: rebuilt("Cisco MAC tables"),
  cisco_neighbors: rebuilt("Cisco neighbours"),
  cisco_port_live_state: rebuilt("Cisco live port state"),
  cisco_vlan_db: rebuilt("Cisco VLAN database"),
  cisco_drift_events: rebuilt("Cisco drift events"),
  ipam_subnets: {
    policy: "data", group: MONITORING, title: "IPAM subnets", label: ["cidr", "label"],
    volatile: ["last_scan_started_at", "last_scan_finished_at", "last_error", "host_count", "alive_count"],
  },
  ipam_hosts: {
    policy: "data", group: MONITORING, title: "IPAM hosts", label: ["ip_address", "dns_name"],
    volatile: ["is_up", "responded_via", "open_ports", "last_seen_at", "last_scan_at", "hostname", "netbios_name", "unifi_name"],
  },
  unifi_device_acks: { policy: "data", group: MONITORING, title: "Acknowledged UniFi devices", label: ["device_name", "mac"] },
  dns_managed_records: { policy: "skip", group: MONITORING, title: "DNS sync ledger", reason: "Rebuilt on every DNS sync; the records themselves live in Technitium." },
  dns_sync_runs: { policy: "skip", group: MONITORING, title: "DNS sync runs", reason: "A history of background runs." },

  // ---- never rewound ----
  audit_log: { policy: "skip", group: OTHER, title: "Audit log", reason: "A record of what happened; a restore must not rewrite it." },
  mail_outbox: runtime("Outgoing mail queue", "Mail waiting to be sent must not be lost or re-sent by a restore."),
  job_state: runtime("Background job state", "Per-cluster runtime state."),
  cluster_nodes: runtime("Cluster nodes", "Which nodes are running right now."),
  cluster_leases: runtime("Cluster leases", "Who holds which lease right now."),
  realtime_events: runtime("Realtime events", "Transient messages between nodes."),
  realtime_presence: runtime("Realtime presence", "Who is connected right now."),
  live_snapshots: runtime("Live snapshots", "The latest copy of polled data."),
  live_search_docs: runtime("Live search documents", "Rebuilt by the pollers."),
  rate_limit_buckets: runtime("Rate limit counters", "Transient counters."),
  backups: runtime("Backups", "The list of backups must survive restoring one of them."),
  backup_schedules: runtime("Backup schedules", "Schedules are configuration of the backup system itself."),
  backup_operations: runtime("Backup operations", "The progress of the restore that is running."),
};

export function tableInfo(name: string): TableInfo {
  const info = TABLE_REGISTRY[name];
  if (!info) throw new Error(`table ${name} has no entry in the backup registry (apps/api/src/backup/table-registry.ts)`);
  return info;
}

export function isBackedUp(name: string): boolean {
  return TABLE_REGISTRY[name]?.policy === "data";
}

// ---------------------------------------------------------------------------------------------
// Sections: what a person can choose to restore
// ---------------------------------------------------------------------------------------------

/** A section a restore can be limited to: the registry's `group`, for the tables a backup saves. */
export interface RestoreSection {
  key: string;
  title: string;
  /** What is in it, in a sentence. */
  description: string;
  /** Titles of the tables in it, for showing exactly what choosing it covers. */
  tables: string[];
  /** Choosing it also covers the uploaded files (the object store), not just rows. */
  hasFiles: boolean;
}

const SECTION_ORDER = [PEOPLE, SETTINGS, HELPDESK, WIKI, NOTES, CHECKLISTS, MONITORING, PRINTERS, FILES];

const SECTION_BLURBS: Record<string, string> = {
  [PEOPLE]: "Users, groups and who can do what, sign-in links, passwords, two-factor secrets and API tokens.",
  [SETTINGS]: "Site settings, dashboard layouts, saved views, notification preferences and Planning Center links.",
  [HELPDESK]: "Tickets, their comments and categories.",
  [WIKI]: "Wiki pages, folders, who may see them and each page's history.",
  [NOTES]: "Notes, tags, notifications and the activity feed.",
  [CHECKLISTS]: "Checklist stations and templates, recurring services, events, tasks and volunteers.",
  [MONITORING]: "Everything under the Monitoring menu: service monitors and incidents, infrastructure hosts, UPS devices, Cisco switches and ports, IPAM subnets and hosts, UniFi acknowledgements.",
  [PRINTERS]: "Printers and their SNMP settings.",
  [FILES]: "Uploaded files (attachments, note images, wiki uploads): their records and the files themselves.",
};

/** The key a section goes by in requests and reports (the same one the comparison report uses). */
export function sectionKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z]+/g, "-");
}

/** The sections a restore can be limited to, in the order a person expects. */
export function restoreSections(): RestoreSection[] {
  return SECTION_ORDER.map((title) => ({
    key: sectionKey(title),
    title,
    description: SECTION_BLURBS[title] ?? "",
    tables: Object.entries(TABLE_REGISTRY)
      .filter(([, i]) => i.policy === "data" && i.group === title)
      .map(([, i]) => i.title)
      .sort((a, b) => a.localeCompare(b)),
    hasFiles: title === FILES,
  }));
}

/** The title of the section a key names, or undefined. */
export function sectionTitle(key: string): string | undefined {
  return SECTION_ORDER.find((t) => sectionKey(t) === key);
}

/** The names of the tables a backup saves that are in these sections. */
export function tablesInSections(keys: string[]): Set<string> {
  const titles = new Set(keys.map(sectionTitle).filter((t): t is string => t !== undefined));
  return new Set(
    Object.entries(TABLE_REGISTRY)
      .filter(([, i]) => i.policy === "data" && titles.has(i.group))
      .map(([name]) => name),
  );
}
