import type { RouteInfo } from "./routes";

/**
 * Where every API route stands with regard to the MCP server. The coverage
 * test (`apps/api/test/mcp-coverage.test.ts`) fails when a route is neither a
 * catalogue tool nor named here, so a new endpoint cannot be forgotten: add a
 * tool, or add a rule that says why not.
 *
 *  - `excluded`: deliberately not offered to agents, with the reason.
 *  - `pending`: will get a tool in the named phase of docs/mcp.md. A rule goes
 *    when its routes get tools; the test fails on a rule that matches nothing.
 *
 * The first matching rule wins, so specific rules come before broad ones.
 * Pattern: `METHOD path`; METHOD may be `*` or `A|B`; in the path `*` stands
 * for one segment (including a `:param`) and a trailing `/**` for the prefix
 * and everything under it.
 */
export interface RouteRule {
  pattern: string;
  status: "excluded" | "pending";
  /** pending only: the phase of docs/mcp.md that delivers it. */
  phase?: 1 | 2 | 3 | 4;
  reason: string;
}

/**
 * Phases whose pending rules must all be gone. Raise it as each phase ships; the
 * coverage test then fails if a rule of a finished phase is still here.
 */
export const COMPLETED_PHASES: number[] = [0, 1, 2, 3, 4];

const SESSION_ONLY = "needs a browser session by design (a leaked token must not be able to do this)";
const NO_SECRETS = "takes credentials as arguments; connection tests stay in the web UI";
const NO_DELETE = "agents cannot delete this (decided 2026-10-12); a person does it in the web app";
const DEVICE_CREDENTIALS =
  "registering or changing a device handles its address and login (SSH, SNMP, API token); a person does it in the web app";
const ADMIN_WRITES = "admin writes are out of scope for agents for now (read-only admin, decided 2026-10-12)";

export const ROUTE_RULES: RouteRule[] = [
  // ---- Never offered ----------------------------------------------------------------------------
  { pattern: "* /admin/backups/**", status: "excluded", reason: `backups and restores: ${SESSION_ONLY}` },
  { pattern: "* /tickets/inbound/**", status: "excluded", reason: `the helpdesk mailbox, which holds a stored login: ${SESSION_ONLY}` },
  { pattern: "* /admin/api-tokens/**", status: "excluded", reason: `token management: ${SESSION_ONLY}` },
  { pattern: "* /admin/users/*/api-tokens/**", status: "excluded", reason: `token management: ${SESSION_ONLY}` },
  { pattern: "* /me/api-tokens/**", status: "excluded", reason: `token management: ${SESSION_ONLY}` },
  { pattern: "* /unifi/vouchers/**", status: "excluded", reason: "guest Wi-Fi codes are a way onto the network, handed out by a person and printed from the web app" },
  { pattern: "* /assistant/**", status: "excluded", reason: `the in-app assistant is itself a model client and spends the site's budget: ${SESSION_ONLY}` },
  { pattern: "GET /reports/monthly", status: "excluded", reason: "who may read the report is decided by group membership (site admins and the report's group), which a tool's permission list cannot say; it is read in the web app" },
  { pattern: "GET /status/public", status: "excluded", reason: "the public copy of /status (which is a tool), for people who are not signed in" },
  { pattern: "* /alert-channels/**", status: "excluded", reason: "alert channels hold webhook addresses and tokens: configured in the web app, like devices with logins" },
  { pattern: "* /me/push/**", status: "excluded", reason: `browser push subscriptions send the owner's notices to a device: ${SESSION_ONLY}` },
  { pattern: "* /me/sessions/**", status: "excluded", reason: `the list of signed-in browsers and ending them: ${SESSION_ONLY}` },
  { pattern: "GET /users/:id/sessions", status: "excluded", reason: "another person's signed-in browsers (addresses and devices) stay in the admin web app" },
  { pattern: "GET /admin/security-posture", status: "excluded", reason: `a map of the site's weak spots: ${SESSION_ONLY}` },
  { pattern: "* /auth/**", status: "excluded", reason: "sign-in, 2FA, invites and password resets are the web app's business" },
  { pattern: "PATCH /me", status: "excluded", reason: `changing the account email: ${SESSION_ONLY}` },
  { pattern: "POST /me/change-password", status: "excluded", reason: `password change: ${SESSION_ONLY}` },
  { pattern: "* /mcp", status: "excluded", reason: "the MCP endpoint itself" },
  { pattern: "GET /metrics", status: "excluded", reason: "Prometheus scrape endpoint" },
  { pattern: "GET /healthz", status: "excluded", reason: "load balancer probe" },
  { pattern: "GET /readyz", status: "excluded", reason: "orchestrator probe" },
  { pattern: "GET /settings/public", status: "excluded", reason: "unauthenticated page bootstrap" },
  { pattern: "GET /site/identity", status: "excluded", reason: "unauthenticated page bootstrap" },
  { pattern: "POST /users/ensure-default-group", status: "excluded", reason: "internal call from the sign-in flow" },
  { pattern: "POST /users/oauth-provision", status: "excluded", reason: "internal call from the sign-in flow" },
  { pattern: "POST /mailer/test", status: "excluded", reason: "sends email on demand" },
  { pattern: "POST /notifications/test-email", status: "excluded", reason: "sends email on demand" },
  { pattern: "POST /search/reindex", status: "excluded", reason: "maintenance operation, not a task for an agent" },
  { pattern: "POST /dns/test", status: "excluded", reason: NO_SECRETS },
  { pattern: "POST /infra/targets/test", status: "excluded", reason: NO_SECRETS },
  { pattern: "POST /printers/test", status: "excluded", reason: NO_SECRETS },
  { pattern: "POST /ups/test", status: "excluded", reason: NO_SECRETS },
  { pattern: "POST /unifi/test", status: "excluded", reason: NO_SECRETS },
  { pattern: "POST /propresenter/test", status: "excluded", reason: NO_SECRETS },
  { pattern: "POST /infra/targets/:id/update-run", status: "excluded", reason: "OS updates on a host: needs a sudo password and has no undo" },
  { pattern: "GET /audit/export.csv", status: "excluded", reason: "a file download; the audit log is read through GET /audit" },
  { pattern: "DELETE /admin/cluster/nodes/:id", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "POST /users/:id/hard-delete", status: "excluded", reason: "permanent removal of an account" },
  { pattern: "POST /users/:id/password", status: "excluded", reason: "sets another person's password" },
  { pattern: "DELETE /*/*/attachments/*", status: "excluded", reason: `${NO_DELETE}; list, read and add are tools` },
  { pattern: "POST /wiki/import", status: "excluded", reason: "file upload (multipart)" },
  { pattern: "POST /wiki/:id/review", status: "excluded", reason: "confirming that a page is still correct is a person's claim; an agent that fixed the page updates it instead" },
  { pattern: "POST /wiki/templates", status: "excluded", reason: "templates are kept by the wiki admins in the web app (an agent reads them with wiki_list_templates)" },
  { pattern: "PATCH /wiki/templates/*", status: "excluded", reason: "templates are kept by the wiki admins in the web app (an agent reads them with wiki_list_templates)" },
  { pattern: "POST /groups/sync-google", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "DELETE /tickets/**", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /ticket-categories/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /notes/*", status: "excluded", reason: `${NO_DELETE}; archive a note with notes_update` },
  { pattern: "DELETE /tags/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /saved-views/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /wiki/**", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /checklists/**", status: "excluded", reason: NO_DELETE },
  { pattern: "POST /infra/targets", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "PATCH|DELETE /infra/targets/*", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "POST /printers", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "PATCH|DELETE /printers/*", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "POST /ups", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "PATCH|DELETE /ups/*", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "POST /cisco/switches", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "PATCH|DELETE /cisco/switches/*", status: "excluded", reason: DEVICE_CREDENTIALS },
  { pattern: "PUT /cisco/switches/*/switch-view", status: "excluded", reason: "which picture the switch page draws is display curation for a person in the web app, with the device profiles page" },
  { pattern: "PUT /unifi/devices/*/switch-view", status: "excluded", reason: "which picture a UniFi device is drawn with is display curation for a person in the web app, with the device profiles page" },
  { pattern: "POST /cisco/switches/*/reset-host-key", status: "excluded", reason: "accepting a changed SSH host key is a trust decision for a person to make in the web app" },
  { pattern: "DELETE /monitors/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /ipam/subnets/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /dns/zones/*/records", status: "excluded", reason: `${NO_DELETE} (it is still operational-only over REST)` },
  { pattern: "DELETE /cisco/switches/*/backups/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /cisco/switches/*/ports/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /cisco/vlans/*", status: "excluded", reason: `${NO_DELETE}; cisco_set_vlan leaves a VLAN off the switches it is not listed for` },
  { pattern: "DELETE /locations/*", status: "excluded", reason: "no delete tools for records people keep; removing a room clears it from everything in it, so a person does it in the web app" },
  { pattern: "GET /locations/*/usage", status: "excluded", reason: "the counts the web app's delete dialog shows; locations_get_summary says what is in a room" },
  { pattern: "GET /locations/*", status: "excluded", reason: "locations_list has every room and locations_get_summary one room with what is in it" },
  { pattern: "DELETE /assets/*", status: "excluded", reason: "no delete tools for records people keep; an item that is gone is marked retired or lost (assets_update)" },
  { pattern: "POST /assets/*/checkout", status: "excluded", reason: "checking an item out is a person's own action at the item (scanning its label), done in the web app" },
  { pattern: "POST /assets/*/return", status: "excluded", reason: "checking an item back in is a person's own action at the item, done in the web app" },
  { pattern: "PUT /assets/*/due", status: "excluded", reason: "the due date is agreed with the person who has the item, in the web app" },
  { pattern: "POST /assets/import", status: "excluded", reason: "a bulk import from a spreadsheet, previewed by a person in the web app; an agent adds items one at a time (assets_create)" },
  { pattern: "POST /livestreams", status: "excluded", reason: "a stream is set up in the web app: its private link is a credential, and the form explains each platform" },
  { pattern: "PATCH /livestreams/:id", status: "excluded", reason: "a stream is set up in the web app: its private link is a credential" },
  { pattern: "DELETE /livestreams/:id", status: "excluded", reason: "no delete tools for records people keep" },
  { pattern: "POST /livestreams/:id/check", status: "excluded", reason: "reads a stream for up to a minute; the checker reads every stream on its own clock" },
  { pattern: "GET /livestreams/:id/snapshot", status: "excluded", reason: "a picture for the web page; livestreams_get already says what the last sample found" },
  { pattern: "POST /livestreams/platforms/:platform/test", status: "excluded", reason: "tries the platforms' API keys, an admin's settings task" },
  { pattern: "GET /livestreams/choices", status: "excluded", reason: "the stream form's pickers (group and monitor names); streams are set up in the web app" },
  { pattern: "GET /livestreams/platforms/resi/encoders", status: "excluded", reason: "a picker for the stream form; needs the Resi keys" },
  { pattern: "PUT|DELETE /service-monitoring/templates/:key", status: "excluded", reason: "a template can run commands on every host it is attached to: written and confirmed by a person in the web app (docs/service-monitoring.md section 6)" },
  { pattern: "POST /service-monitoring/templates/:key/fork", status: "excluded", reason: "template authoring is a person's task in the web app (a template can run commands on hosts)" },
  { pattern: "GET|POST|PATCH|DELETE /service-monitoring/logins/**", status: "excluded", reason: "saved logins are credentials, entered in the web app" },
  { pattern: "POST|PATCH|DELETE /service-monitoring/instances/**", status: "excluded", reason: "attaching a template to a host can run commands there and holds secrets: set up and confirmed in the web app" },
  { pattern: "POST /service-monitoring/test", status: "excluded", reason: "runs a template against a host (possibly commands) to help a person write it; the poller reads every service on its own clock" },
  { pattern: "POST /service-monitoring/targets/:id/suggestions", status: "excluded", reason: "a live look at a host's units for the add-service dialog" },
  { pattern: "DELETE /renewals/:id", status: "excluded", reason: "no delete tools for records people keep; a renewal that is no longer wanted is removed in the web app" },
  { pattern: "POST|PATCH|DELETE /racks/**", status: "excluded", reason: "where a device physically sits is recorded by a person standing at the cabinet, in the web app; an agent can read the cabinets (racks_get)" },
  { pattern: "GET /racks/candidates", status: "excluded", reason: "the placement picker in the web app; the same devices are listed by cisco_list_switches, infra_list_targets and unifi_list_devices" },
  { pattern: "* /switch-models/**", status: "excluded", reason: "picture-and-layout curation for the web app's switch view (drawing boxes on a photo); there is nothing here for an agent to read or decide" },
  { pattern: "POST|DELETE /planning-center/me/link", status: "excluded", reason: "linking a login to a Planning Center person is a personal account setting, done in the web app" },
  { pattern: "POST /planning-center/links", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "DELETE /planning-center/links/*", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "* /dashboard/**", status: "excluded", reason: "the home page's draggable layout and look are personal UI state, set in the web app; dashboard_get_home gives the data" },
  { pattern: "POST|PUT|PATCH|DELETE /users/**", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "POST|PUT|PATCH|DELETE /groups/**", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "PUT|DELETE /settings/**", status: "excluded", reason: ADMIN_WRITES },
];

function compile(pattern: string): { methods: Set<string> | null; path: RegExp } {
  const space = pattern.indexOf(" ");
  const methodPart = pattern.slice(0, space);
  const pathPart = pattern.slice(space + 1);
  const methods = methodPart === "*" ? null : new Set(methodPart.split("|"));
  let source = "";
  const segments = pathPart.split("/").filter(Boolean);
  for (const seg of segments) {
    if (seg === "**") {
      // Everything below, and the prefix itself.
      source += "(?:/.*)?";
    } else if (seg === "*") {
      source += "/[^/]+";
    } else {
      source += "/" + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { methods, path: new RegExp(`^${source}$`) };
}

const COMPILED = ROUTE_RULES.map((rule) => ({ rule, ...compile(rule.pattern) }));

/** The first rule that covers the route, if any. */
export function ruleFor(route: Pick<RouteInfo, "method" | "path">): RouteRule | undefined {
  return COMPILED.find((c) => (c.methods === null || c.methods.has(route.method)) && c.path.test(route.path))?.rule;
}
