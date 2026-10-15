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
  { pattern: "* /admin/api-tokens/**", status: "excluded", reason: `token management: ${SESSION_ONLY}` },
  { pattern: "* /admin/users/*/api-tokens/**", status: "excluded", reason: `token management: ${SESSION_ONLY}` },
  { pattern: "* /me/api-tokens/**", status: "excluded", reason: `token management: ${SESSION_ONLY}` },
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
  { pattern: "DELETE /monitors/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /ipam/subnets/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /dns/zones/*/records", status: "excluded", reason: `${NO_DELETE} (it is still operational-only over REST)` },
  { pattern: "DELETE /cisco/switches/*/backups/*", status: "excluded", reason: NO_DELETE },
  { pattern: "DELETE /cisco/switches/*/ports/*", status: "excluded", reason: NO_DELETE },
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
