/**
 * Catalogue of known DB-stored settings. Anything the operator can change at
 * runtime (without editing files) goes here. Future Phase 1+ wiring reads
 * values from the `settings` table using these keys.
 *
 * Truly bootstrap-time things — DB URL, Redis URL, AUTH_SECRET — stay in env
 * because they're needed before the DB is reachable. Everything else lives here.
 */

import { z } from "zod";
import { PERMISSIONS, type PermissionString } from "./permissions";

export type SettingType = "string" | "boolean" | "number" | "secret" | "json";

export interface KnownSetting<T = unknown> {
  key: string;
  type: SettingType;
  label: string;
  description: string;
  defaultValue: T;
  category:
    | "site"
    | "auth"
    | "google"
    | "microsoft"
    | "smtp"
    | "printers"
    | "propresenter"
    | "planning_center"
    | "monitoring"
    | "experimental";
}

export const KNOWN_SETTINGS: ReadonlyArray<KnownSetting> = [
  // Site
  {
    key: "site.name",
    type: "string",
    label: "Site name",
    description: "Shown in the page title and emails.",
    defaultValue: "Church Dashboard",
    category: "site",
  },
  {
    key: "site.url",
    type: "string",
    label: "Site URL",
    description:
      "Public base URL of this dashboard, e.g. https://dashboard.mychurch.org — used to build clickable links in welcome, invite, reset, and notification emails. Leave blank to fall back to whatever host each request arrives on (fine for local dev, wrong for real emails).",
    defaultValue: "",
    category: "site",
  },
  {
    key: "site.tagline",
    type: "string",
    label: "Tagline",
    description: "Shown under the site name on sign-in.",
    defaultValue: "",
    category: "site",
  },
  {
    key: "site.footer_message",
    type: "string",
    label: "Footer message",
    description:
      "Shown on the right side of the footer on every page. Use it for a copyright line, hosting credit, or contact info. Leave blank to hide.",
    defaultValue: "",
    category: "site",
  },
  // Auth — top-level toggles. Provider credentials live in each provider's
  // own category block so the operator can edit them from a dedicated page.
  {
    key: "auth.local.enabled",
    type: "boolean",
    label: "Allow local sign-in",
    description: "Email + password sign-in. If off, users must use a configured OAuth provider.",
    defaultValue: true,
    category: "auth",
  },
  {
    key: "auth.google.enabled",
    type: "boolean",
    label: "Allow sign-in with Google",
    description: "Master switch for Google OAuth. Leave on but with empty credentials to temporarily disable.",
    defaultValue: true,
    category: "auth",
  },
  {
    key: "auth.microsoft.enabled",
    type: "boolean",
    label: "Allow sign-in with Microsoft",
    description: "Master switch for Microsoft Entra ID / personal account sign-in.",
    defaultValue: false,
    category: "auth",
  },
  {
    key: "auth.require_totp_admin",
    type: "boolean",
    label: "Require 2FA for admins",
    description:
      "When on, admins who haven't enrolled TOTP can sign in but are forced through /me/totp/enroll before they can use anything else. Off by default — flip on once your admins have phones in hand.",
    defaultValue: false,
    category: "auth",
  },
  {
    key: "auth.require_totp_all",
    type: "boolean",
    label: "Require 2FA for all users",
    description:
      "Same enforcement as the admin toggle but for every signed-in user. Off by default.",
    defaultValue: false,
    category: "auth",
  },
  {
    key: "audit.retention_days",
    type: "number",
    label: "Audit log retention (days)",
    description:
      "Audit rows older than this are pruned by a nightly job. 0 disables pruning. Defaults to a year.",
    defaultValue: 365,
    category: "site",
  },
  // Ticket SLAs. Targets are in minutes; "response" = time-to-first-engagement
  // (a non-creator comment or an assignment), "resolution" = time-to-status≥resolved.
  // 0 disables the clock for that priority. Default values are a starting
  // sketch for a small church IT team; tune in /admin/settings.
  {
    key: "tickets.sla.response_min.urgent",
    type: "number",
    label: "SLA — urgent: first-response (minutes)",
    description: "Target time from ticket creation to first staff response, for urgent tickets.",
    defaultValue: 60,
    category: "site",
  },
  {
    key: "tickets.sla.resolution_min.urgent",
    type: "number",
    label: "SLA — urgent: resolution (minutes)",
    description: "Target time from creation to status=resolved, for urgent tickets.",
    defaultValue: 240,
    category: "site",
  },
  {
    key: "tickets.sla.response_min.high",
    type: "number",
    label: "SLA — high: first-response (minutes)",
    description: "First-response target for high-priority tickets.",
    defaultValue: 240,
    category: "site",
  },
  {
    key: "tickets.sla.resolution_min.high",
    type: "number",
    label: "SLA — high: resolution (minutes)",
    description: "Resolution target for high-priority tickets.",
    defaultValue: 1440,
    category: "site",
  },
  {
    key: "tickets.sla.response_min.normal",
    type: "number",
    label: "SLA — normal: first-response (minutes)",
    description: "First-response target for normal tickets. 0 disables.",
    defaultValue: 1440,
    category: "site",
  },
  {
    key: "tickets.sla.resolution_min.normal",
    type: "number",
    label: "SLA — normal: resolution (minutes)",
    description: "Resolution target for normal tickets. 0 disables.",
    defaultValue: 4320,
    category: "site",
  },
  {
    key: "tickets.sla.response_min.low",
    type: "number",
    label: "SLA — low: first-response (minutes)",
    description: "First-response target for low-priority tickets. 0 disables.",
    defaultValue: 0,
    category: "site",
  },
  {
    key: "tickets.sla.resolution_min.low",
    type: "number",
    label: "SLA — low: resolution (minutes)",
    description: "Resolution target for low-priority tickets. 0 disables.",
    defaultValue: 0,
    category: "site",
  },
  // Google Workspace
  {
    key: "google.oauth.client_id",
    type: "string",
    label: "Google OAuth Client ID",
    description: "From Google Cloud Console — Web application.",
    defaultValue: "",
    category: "google",
  },
  {
    key: "google.oauth.client_secret",
    type: "secret",
    label: "Google OAuth Client Secret",
    description: "Paired with the client ID.",
    defaultValue: "",
    category: "google",
  },
  {
    key: "google.workspace_domain",
    type: "string",
    label: "Workspace domain",
    description:
      "If set, accounts on this domain (e.g. mychurch.org) are auto-accepted into the default user group. Leave blank to allow any Google account. Clear it with the Clear button.",
    defaultValue: "",
    category: "google",
  },
  {
    key: "google.allow_external_with_approval",
    type: "boolean",
    label: "Allow external accounts (with admin approval)",
    description:
      "When on, any Google account (personal Gmail or another workspace) may sign in, but accounts outside the workspace domain land in a pending state with no access until an admin approves them under Admin > Users. Useful for volunteers. When off, a set workspace domain locks sign-in to that domain.",
    defaultValue: false,
    category: "google",
  },
  // Microsoft Entra ID / personal Microsoft accounts
  {
    key: "microsoft.oauth.client_id",
    type: "string",
    label: "Microsoft OAuth Application (Client) ID",
    description: "From Azure / Entra ID — App registrations → Overview.",
    defaultValue: "",
    category: "microsoft",
  },
  {
    key: "microsoft.oauth.client_secret",
    type: "secret",
    label: "Microsoft OAuth Client Secret",
    description: "Value of the client secret created under Certificates & secrets.",
    defaultValue: "",
    category: "microsoft",
  },
  {
    key: "microsoft.oauth.tenant",
    type: "string",
    label: "Microsoft tenant",
    description:
      "Tenant id, 'common' (work/school + personal), 'organizations' (work/school only), or 'consumers' (personal only). Default 'common'.",
    defaultValue: "common",
    category: "microsoft",
  },
  {
    key: "microsoft.allowed_domains",
    type: "string",
    label: "Allowed email domains",
    description:
      "Comma-separated list of email domains permitted to sign in via Microsoft (e.g. 'mychurch.org,contoso.com'). Blank = allow any.",
    defaultValue: "",
    category: "microsoft",
  },
  // SMTP
  {
    key: "smtp.host",
    type: "string",
    label: "SMTP host",
    description: "Hostname of the outbound mail server. Leave blank to disable email.",
    defaultValue: "",
    category: "smtp",
  },
  {
    key: "smtp.port",
    type: "number",
    label: "SMTP port",
    description: "Usually 587 for STARTTLS, 465 for implicit TLS, 25 for plain.",
    defaultValue: 587,
    category: "smtp",
  },
  {
    key: "smtp.username",
    type: "string",
    label: "SMTP username",
    description: "If your SMTP server requires authentication.",
    defaultValue: "",
    category: "smtp",
  },
  {
    key: "smtp.password",
    type: "secret",
    label: "SMTP password",
    description: "Paired with the username.",
    defaultValue: "",
    category: "smtp",
  },
  {
    key: "smtp.from_email",
    type: "string",
    label: "From address",
    description: "All outbound mail uses this as the From: address.",
    defaultValue: "noreply@church.local",
    category: "smtp",
  },
  {
    key: "smtp.from_name",
    type: "string",
    label: "From name",
    description: "Display name on outbound mail.",
    defaultValue: "Church Dashboard",
    category: "smtp",
  },
  {
    key: "smtp.secure",
    type: "boolean",
    label: "Use TLS",
    description: "True for implicit TLS on port 465; false otherwise.",
    defaultValue: false,
    category: "smtp",
  },
  {
    key: "smtp.reject_unauthorized",
    type: "boolean",
    label: "Verify TLS certificate",
    description:
      "Reject mail relays presenting an untrusted/self-signed cert. Turn off only for internal relays where you trust the network path — leaves the connection open to MITM otherwise.",
    defaultValue: true,
    category: "smtp",
  },
  // UniFi (Phase 2.2). Read-only views over the Network Application's REST API.
  {
    key: "unifi.controller_url",
    type: "string",
    label: "UniFi controller URL",
    description:
      "Base URL of the UniFi Network app (e.g. https://192.168.1.1 for UDM, or https://controller.local:8443).",
    defaultValue: "",
    category: "monitoring",
  },
  {
    key: "unifi.api_key",
    type: "secret",
    label: "UniFi API key",
    description:
      "API key for the UniFi Network app (Settings → Admins → API Keys on UniFi OS 9+). Sent as X-API-Key.",
    defaultValue: "",
    category: "monitoring",
  },
  {
    key: "unifi.site_id",
    type: "string",
    label: "UniFi site id",
    description: "Site identifier in the controller. Default is 'default'.",
    defaultValue: "default",
    category: "monitoring",
  },
  {
    key: "unifi.verify_tls",
    type: "boolean",
    label: "Verify TLS certificate",
    description:
      "Off for self-signed controller certs (UDM out of the box). Turn on if you've installed a real cert.",
    defaultValue: false,
    category: "monitoring",
  },
  {
    key: "unifi.alert_device_offline",
    type: "boolean",
    label: "Alert on UniFi device offline",
    description:
      "Notify monitoring admins (in-app + email) when a UniFi device (AP, switch, gateway) goes offline or recovers. Requires a configured controller.",
    defaultValue: false,
    category: "monitoring",
  },
  // DNS (Monitoring → DNS). A Technitium DNS Server cluster, driven over its
  // HTTP API. Only the cluster primary is configured here: it is the only node
  // that accepts zone edits, and it aggregates stats for the whole cluster.
  {
    key: "dns.primary_url",
    type: "string",
    label: "Technitium primary URL",
    description:
      "Base URL of the Technitium cluster primary's web console/API (e.g. https://dns1.int.example.org:53443). Change it after promoting a secondary.",
    defaultValue: "",
    category: "monitoring",
  },
  {
    key: "dns.api_token",
    type: "secret",
    label: "Technitium API token",
    description:
      "API token for a dedicated Technitium user (Administration → Sessions → Create Token). Needs View on Dashboard, Zones and Administration; edits in later phases also need Modify on Zones.",
    defaultValue: "",
    category: "monitoring",
  },
  {
    key: "dns.verify_tls",
    type: "boolean",
    label: "Verify Technitium TLS certificate",
    description:
      "Off for Technitium's self-signed certificate. Turn on if the web console has a trusted cert.",
    defaultValue: false,
    category: "monitoring",
  },
  {
    key: "dns.alert_unreachable",
    type: "boolean",
    label: "Alert when the Technitium primary is unreachable",
    description:
      "Notify monitoring admins (in-app + email) when the primary's API stops answering for 3 minutes, and when it recovers. Lookups keep working on the secondary; this is about edits and the IPAM sync. Silenced by maintenance mode.",
    defaultValue: false,
    category: "monitoring",
  },
  // IPAM -> DNS sync: A (+PTR) records for named hosts in subnets with
  // "Publish to DNS" on. Records it writes carry a managed-by comment and are
  // the only ones it ever changes.
  {
    key: "dns.sync_enabled",
    type: "boolean",
    label: "Sync IPAM hosts to DNS",
    description:
      "Write A (and PTR) records for named hosts in subnets with \"Publish to DNS\" on. Review the plan on the DNS tab's Sync view before turning this on.",
    defaultValue: false,
    category: "monitoring",
  },
  {
    key: "dns.sync_zone",
    type: "string",
    label: "DNS sync zone",
    description:
      "Primary zone the sync writes A records into, e.g. int.example.org (avoid .local, which belongs to mDNS).",
    defaultValue: "",
    category: "monitoring",
  },
  {
    key: "dns.sync_ptr",
    type: "boolean",
    label: "Also write PTR records",
    description:
      "Write reverse (PTR) records into matching in-addr.arpa zones. A missing reverse zone is reported, never created silently.",
    defaultValue: true,
    category: "monitoring",
  },
  {
    key: "dns.record_ttl",
    type: "number",
    label: "Synced record TTL (seconds)",
    description: "TTL for records the sync writes. Short keeps DHCP address changes visible quickly.",
    defaultValue: 300,
    category: "monitoring",
  },
  {
    key: "dns.stale_days",
    type: "number",
    label: "Remove synced records after (days unseen)",
    description: "A synced record is removed once its host hasn't been seen up by the IPAM scanner for this many days.",
    defaultValue: 14,
    category: "monitoring",
  },
  // Printers — SNMP defaults + polling cadence. Per-printer values on the
  // `printers` rows override these when set.
  {
    key: "printers.default_snmp_version",
    type: "string",
    label: "Default SNMP version",
    description: "Used when a printer row doesn't specify its own. v1 or v2c.",
    defaultValue: "v2c",
    category: "printers",
  },
  {
    key: "printers.default_snmp_community",
    type: "string",
    label: "Default SNMP community",
    description: "Read community used when a printer row doesn't set its own (most printers ship with 'public').",
    defaultValue: "public",
    category: "printers",
  },
  {
    key: "printers.snmp_timeout_ms",
    type: "number",
    label: "SNMP timeout (ms)",
    description: "How long to wait for an SNMP reply before marking the printer red.",
    defaultValue: 3000,
    category: "printers",
  },
  {
    key: "printers.poll_interval_min",
    type: "number",
    label: "Background poll interval (minutes)",
    description: "How often the API polls every enabled printer for status + supplies.",
    defaultValue: 5,
    category: "printers",
  },
  {
    key: "printers.fiery_timeout_ms",
    type: "number",
    label: "Fiery REST timeout (ms)",
    description: "Timeout for the Fiery queue-depth HTTP call on Fiery printers.",
    defaultValue: 5000,
    category: "printers",
  },
  // ProPresenter (Phase 2.3). HTTP/WebSocket adapter for the live remote.
  {
    key: "propresenter.host",
    type: "string",
    label: "ProPresenter host",
    description: "Hostname or IP of the machine running ProPresenter 7.",
    defaultValue: "",
    category: "propresenter",
  },
  {
    key: "propresenter.port",
    type: "number",
    label: "ProPresenter HTTP port",
    description: "Network interface port set in PP7 → Preferences → Network. Default 1025.",
    defaultValue: 1025,
    category: "propresenter",
  },
  {
    key: "propresenter.password",
    type: "secret",
    label: "ProPresenter remote password",
    description: "Password set on the PP7 Network preferences pane. Empty if none.",
    defaultValue: "",
    category: "propresenter",
  },
  // Planning Center. Server-to-server uses a Personal Access Token (app-id +
  // secret) sent as HTTP Basic. Create one at
  // https://api.planningcenteronline.com/oauth/applications  (Personal Access
  // Tokens) — needs at least the Services product enabled on the account.
  {
    key: "planning_center.app_id",
    type: "string",
    label: "Planning Center app id",
    description: "Personal Access Token application id (the username half of Basic auth).",
    defaultValue: "",
    category: "planning_center",
  },
  {
    key: "planning_center.secret",
    type: "secret",
    label: "Planning Center secret",
    description: "Personal Access Token secret (the password half of Basic auth).",
    defaultValue: "",
    category: "planning_center",
  },
  {
    key: "planning_center.default_service_type_id",
    type: "string",
    label: "Default service type id",
    description:
      "Numeric id of the Service Type the dashboard tile shows by default (find it under Services → a service → URL, e.g. /service_types/12345).",
    defaultValue: "",
    category: "planning_center",
  },
  // Infrastructure monitoring (agentless: SSH / Proxmox API / Docker over SSH).
  // Per-target connection, credentials, interval and alert thresholds live on the
  // target rows (edited at /monitoring/infra). These are global collector knobs;
  // changes take effect on the next API restart.
  {
    key: "monitoring.maintenance_mode",
    type: "boolean",
    label: "Maintenance mode (silence alerts)",
    description:
      "When on, monitoring alert notifications (infrastructure thresholds, service up/down, UniFi device offline) are suppressed. Incidents are still recorded so history stays intact — only the in-app/email fan-out is paused. Toggle from the banner at the top of any Monitoring tab.",
    defaultValue: false,
    category: "monitoring",
  },
  {
    key: "monitoring.tick_seconds",
    type: "number",
    label: "Collector tick interval (seconds)",
    description:
      "How often the collector wakes to poll targets that are due. Individual targets still poll at their own configured interval; this is the scheduler granularity.",
    defaultValue: 15,
    category: "monitoring",
  },
  {
    key: "monitoring.poll_concurrency",
    type: "number",
    label: "Poll concurrency",
    description: "Maximum number of targets polled at once. Raise for larger fleets.",
    defaultValue: 6,
    category: "monitoring",
  },
  // IPAM — periodic sweep of the managed subnets (Monitoring → IPAM). Ranges
  // are added manually or discovered from Cisco/UniFi; these knobs govern the
  // background scanner. Changes take effect on the next sweep.
  {
    key: "monitoring.ipam_scan_enabled",
    type: "boolean",
    label: "Enable IPAM scanning",
    description:
      "Master switch for the background subnet sweep. Off leaves the inventory static (you can still add subnets and scan on demand).",
    defaultValue: false,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_scan_interval_min",
    type: "number",
    label: "IPAM scan interval (minutes)",
    description: "How often every scan-enabled subnet is swept for live hosts.",
    defaultValue: 60,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_concurrency",
    type: "number",
    label: "IPAM scan concurrency",
    description: "How many host probes run at once within a subnet sweep. Raise for faster (noisier) scans.",
    defaultValue: 32,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_host_timeout_ms",
    type: "number",
    label: "IPAM per-host timeout (ms)",
    description: "How long to wait for an ICMP reply or TCP handshake before treating a host as down.",
    defaultValue: 1000,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_dns_lookup",
    type: "boolean",
    label: "IPAM reverse DNS lookup",
    description: "Resolve each live host's PTR record to a hostname during the sweep.",
    defaultValue: true,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_netbios",
    type: "boolean",
    label: "IPAM NetBIOS name lookup",
    description: "Query each live host for its NetBIOS name (nbstat, UDP/137) — useful for naming Windows hosts.",
    defaultValue: false,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_unifi_names",
    type: "boolean",
    label: "IPAM UniFi name lookup",
    description:
      "Name live hosts from the UniFi controller's client list (operator alias or DHCP hostname). This is where phone/IoT names come from — those devices only announce over link-local mDNS, which never reaches the off-subnet scanner.",
    defaultValue: true,
    category: "monitoring",
  },
  {
    key: "monitoring.ipam_tcp_ports",
    type: "string",
    label: "IPAM TCP fallback ports",
    description:
      "Comma-separated TCP ports probed when a host doesn't answer ICMP; a completed handshake OR a refusal counts the host as up. e.g. 22,80,443,445,3389.",
    defaultValue: "22,80,443,445,3389,139,7,9100,62078",
    category: "monitoring",
  },
  // UPS (SNMP, UPS-MIB / RFC 1628). SNMP defaults + polling cadence; per-UPS
  // values on the `ups_devices` rows override these when set.
  {
    key: "monitoring.ups_default_snmp_version",
    type: "string",
    label: "UPS default SNMP version",
    description: "Used when a UPS row doesn't specify its own. v1 or v2c.",
    defaultValue: "v2c",
    category: "monitoring",
  },
  {
    key: "monitoring.ups_default_snmp_community",
    type: "string",
    label: "UPS default SNMP community",
    description: "Read community used when a UPS row doesn't set its own (most ship with 'public').",
    defaultValue: "public",
    category: "monitoring",
  },
  {
    key: "monitoring.ups_snmp_timeout_ms",
    type: "number",
    label: "UPS SNMP timeout (ms)",
    description: "How long to wait for an SNMP reply before marking the UPS unreachable.",
    defaultValue: 3000,
    category: "monitoring",
  },
  {
    key: "monitoring.ups_poll_interval_min",
    type: "number",
    label: "UPS poll interval (minutes)",
    description: "How often the API polls every enabled UPS for battery, load, and runtime.",
    defaultValue: 5,
    category: "monitoring",
  },
] as const;

export const settingKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,127}$/, "lowercase, digits, dot, underscore, dash; must start with a letter");

export function findKnownSetting(key: string): KnownSetting | undefined {
  return KNOWN_SETTINGS.find((s) => s.key === key);
}

/**
 * Per-category management permission. A category maps to the permission that
 * lets a *module* admin manage that category's settings (including secrets)
 * without being a full site admin. `null` means the category is core site
 * administration: only `site:admin` may write it (a `settings:read:any` role
 * may still read it, redacted).
 *
 * Authorisation semantics (enforced in the settings controller):
 *   - canWrite(category) = site:admin OR holds the category's manage permission
 *   - canRead(category)  = canWrite OR settings:read:any
 *   - a `secret` value is returned unredacted only when the caller canWrite.
 * Keys with no known category fall through to site:admin only.
 */
export const SETTING_CATEGORY_MANAGE_PERMISSION: Record<string, PermissionString | null> = {
  site: null,
  auth: null,
  google: null,
  microsoft: null,
  smtp: null,
  experimental: null,
  printers: PERMISSIONS.PRINTERS_ADMIN,
  propresenter: PERMISSIONS.PROPRESENTER_ADMIN,
  planning_center: PERMISSIONS.PLANNING_CENTER_ADMIN,
  monitoring: PERMISSIONS.MONITORS_WRITE_ANY,
};

/** Category of a known setting key, or null when the key isn't in the catalogue. */
export function settingCategory(key: string): string | null {
  return findKnownSetting(key)?.category ?? null;
}

/**
 * Module-admin permission that manages a category, or null when the category is
 * core site administration (or unknown). Unknown categories return null, which
 * the controller treats as "site:admin only".
 */
export function categoryManagePermission(category: string | null): PermissionString | null {
  if (category === null) return null;
  return SETTING_CATEGORY_MANAGE_PERMISSION[category] ?? null;
}

/**
 * Cross-setting invariants for boolean "enable" toggles: a provider can't be
 * switched on until its credentials exist. The toggle and the credentials live
 * in different categories (the toggle under `auth`, the secrets under the
 * provider's own page), so this can't be a single-form check — the API enforces
 * it in `settings.set` and the settings UI uses the same data to disable the
 * toggle with a hint. Workspace/tenant domain is deliberately NOT required:
 * blank means "allow any account", which is how external sign-in works.
 */
export interface TogglePrerequisite {
  /** Boolean setting that may only be set true once every `requires` key is non-empty. */
  toggleKey: string;
  /** Setting keys that must each hold a non-empty value first. */
  requires: string[];
  /** Provider name for error/hint copy. */
  providerLabel: string;
  /** Settings category slug (`/admin/settings/<slug>`) where `requires` are edited. */
  categorySlug: string;
}

export const TOGGLE_PREREQUISITES: ReadonlyArray<TogglePrerequisite> = [
  {
    toggleKey: "auth.google.enabled",
    requires: ["google.oauth.client_id", "google.oauth.client_secret"],
    providerLabel: "Google",
    categorySlug: "google",
  },
  {
    toggleKey: "auth.microsoft.enabled",
    requires: ["microsoft.oauth.client_id", "microsoft.oauth.client_secret"],
    providerLabel: "Microsoft",
    categorySlug: "microsoft",
  },
  {
    toggleKey: "dns.sync_enabled",
    requires: ["dns.primary_url", "dns.api_token", "dns.sync_zone"],
    providerLabel: "DNS sync",
    categorySlug: "monitoring",
  },
];

export function findTogglePrerequisite(key: string): TogglePrerequisite | undefined {
  return TOGGLE_PREREQUISITES.find((t) => t.toggleKey === key);
}
