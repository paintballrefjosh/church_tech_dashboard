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
export const COMPLETED_PHASES: number[] = [0];

const SESSION_ONLY = "needs a browser session by design (a leaked token must not be able to do this)";
const NO_SECRETS = "takes credentials as arguments; connection tests stay in the web UI";
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
  { pattern: "* /*/*/attachments/**", status: "excluded", reason: "binary upload/download is designed separately and is not in the first pass" },
  { pattern: "POST /wiki/import", status: "excluded", reason: "file upload (multipart)" },
  { pattern: "POST /groups/sync-google", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "POST|PUT|PATCH|DELETE /users/**", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "POST|PUT|PATCH|DELETE /groups/**", status: "excluded", reason: ADMIN_WRITES },
  { pattern: "PUT|DELETE /settings/**", status: "excluded", reason: ADMIN_WRITES },

  // ---- Phase 3: acts on live equipment (needs the operational token level) ----------------------
  { pattern: "POST /propresenter/next", status: "pending", phase: 3, reason: "changes what the projector shows" },
  { pattern: "POST /propresenter/previous", status: "pending", phase: 3, reason: "changes what the projector shows" },
  { pattern: "POST /propresenter/clear", status: "pending", phase: 3, reason: "changes what the projector shows" },
  { pattern: "POST /cisco/switches/*/ports/*/toggle", status: "pending", phase: 3, reason: "shuts or opens a switch port" },
  { pattern: "POST /cisco/switches/*/drift/**", status: "pending", phase: 3, reason: "pushes configuration to a switch or accepts drift" },
  { pattern: "POST /cisco/switches/*/backups/trigger-full", status: "pending", phase: 3, reason: "logs into every switch" },
  { pattern: "POST /cisco/switches/*/collect-l2", status: "pending", phase: 3, reason: "logs into a switch" },
  { pattern: "POST /cisco/switches/*/discover", status: "pending", phase: 3, reason: "logs into a switch" },
  { pattern: "POST /cisco/switches/*/poll", status: "pending", phase: 3, reason: "logs into a switch" },
  { pattern: "POST|PATCH|DELETE /dns/zones/*/records", status: "pending", phase: 3, reason: "edits live DNS" },
  { pattern: "POST /dns/sync", status: "pending", phase: 3, reason: "writes many DNS records" },
  { pattern: "POST /dns/reverse-zones", status: "pending", phase: 3, reason: "creates DNS zones" },
  { pattern: "POST /dns/managed/*/release", status: "pending", phase: 3, reason: "changes DNS ownership markers" },
  { pattern: "POST /infra/targets/*/poll-now", status: "pending", phase: 3, reason: "logs into a host" },
  { pattern: "POST /infra/targets/*/discover-services", status: "pending", phase: 3, reason: "logs into a host" },
  { pattern: "POST /ipam/subnets/*/scan", status: "pending", phase: 3, reason: "scans a network" },
  { pattern: "POST /printers/*/poll", status: "pending", phase: 3, reason: "queries a printer" },
  { pattern: "POST /ups/*/poll", status: "pending", phase: 3, reason: "queries a UPS" },

  // ---- Phase 4: read-only admin ------------------------------------------------------------------
  { pattern: "GET /users/**", status: "pending", phase: 4, reason: "user directory (read-only)" },
  { pattern: "GET /groups/**", status: "pending", phase: 4, reason: "groups and module access (read-only)" },
  { pattern: "GET /settings", status: "pending", phase: 4, reason: "settings, secrets redacted (read-only)" },
  { pattern: "GET /settings/*", status: "pending", phase: 4, reason: "settings, secrets redacted (read-only)" },
  { pattern: "GET /audit", status: "pending", phase: 4, reason: "audit log (read-only)" },
  { pattern: "GET /admin/cluster", status: "pending", phase: 4, reason: "cluster status (read-only)" },

  // ---- Phase 2: monitoring and the rest of IT ----------------------------------------------------
  { pattern: "* /monitors/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "GET /health/services", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /infra/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /unifi/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /printers/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /ups/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /ipam/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /dns/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /cisco/**", status: "pending", phase: 2, reason: "monitoring" },
  { pattern: "* /planning-center/**", status: "pending", phase: 2, reason: "Planning Center" },
  { pattern: "GET /propresenter/**", status: "pending", phase: 2, reason: "ProPresenter status" },

  // ---- Phase 1: work content ---------------------------------------------------------------------
  { pattern: "* /tickets/**", status: "pending", phase: 1, reason: "helpdesk" },
  { pattern: "* /ticket-categories/**", status: "pending", phase: 1, reason: "helpdesk" },
  { pattern: "* /notes/**", status: "pending", phase: 1, reason: "notes" },
  { pattern: "* /tags/**", status: "pending", phase: 1, reason: "tags" },
  { pattern: "* /saved-views/**", status: "pending", phase: 1, reason: "saved views" },
  { pattern: "GET /activity", status: "pending", phase: 1, reason: "activity feed" },
  { pattern: "* /notifications/**", status: "pending", phase: 1, reason: "notification centre" },
  { pattern: "* /me/**", status: "pending", phase: 1, reason: "own account" },
  { pattern: "* /dashboard/**", status: "pending", phase: 1, reason: "home page data and preferences" },
  { pattern: "* /checklists/**", status: "pending", phase: 1, reason: "checklists" },
  { pattern: "* /wiki/**", status: "pending", phase: 1, reason: "wiki (the first 7 tools exist; the rest are the gaps)" },
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
