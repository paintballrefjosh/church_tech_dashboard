# MCP: the whole app for agents

Plan, rules and status for making everything the web app can do (with a few deliberate exceptions) available
through the MCP server at `/api/v1/mcp`. Decided 2026-10-12. Operator docs: INSTALL.md "Connecting Claude (MCP)".

## Status

| Phase | Scope | State |
|---|---|---|
| **0. Bridge** | In-process route bridge, tool catalogue, route-coverage test, per-caller tool listing, smoke tests | **done** |
| 1. Work content | Tickets, notes, tags, saved views, activity, notifications, `me`, dashboard, checklists; wiki gaps (revert, revision, ACL/visibility) | next |
| 2. Monitoring and IT | Monitors, infra, UniFi, printers, UPS, IPAM, DNS, Cisco, Planning Center, ProPresenter status; their record-level writes | |
| 3. Operational | Anything that acts on live equipment (ProPresenter slides, switch ports, DNS records, polls, scans). Needs the new "operational" token level | |
| 4. Read-only admin | Users, groups and module access, settings (secrets redacted), audit log, cluster status | |

The coverage test lists what is still pending: `ROUTE_RULES` in `apps/api/src/mcp/bridge/route-rules.ts`
(`pending` entries carry their phase). `COMPLETED_PHASES` in the same file is raised when a phase ships.

## Design

**A tool is a typed door onto an existing REST route, called in-process with the caller's own bearer token.**
`ApiBridge` (`apps/api/src/mcp/bridge/api-bridge.service.ts`) builds the URL and body from the tool's flat
arguments and calls Fastify `inject`. Because the request really goes through the route:

- guards, the token's module list, read-only and `@SessionOnly` are enforced by the same code as for REST;
- the controller's own work happens (realtime events, "assigned to you" notifications, search updates), which a
  tool calling a service directly would silently skip (`PATCH /tickets/:id` does this in the controller);
- the audit interceptor writes the usual row, with the token id (the MCP route itself uses
  `startDynamicAudit`, so a read-only MCP call writes nothing);
- the restore gate, rate limit and read-your-writes cookie apply.

Rules for adding a tool (`apps/api/src/mcp/bridge/catalogue/<area>.tools.ts`, registered in `catalogue/index.ts`):

1. `defineTool({ name, title, description, cls, method, path, permissions, input })`. `path` is the route exactly as
   the controller declares it; `permissions` equals the route's `@RequirePermissions` (a test compares them);
   `input` is the Zod schema the route validates with, reused from `packages/shared` where one exists, flattened
   with the path parameters. The JSON Schema the client sees is generated from it (`zod-to-json-schema`), never
   written by hand.
2. Names are `<area>_<verb>_<thing>`, snake_case. Descriptions say when to use the tool and what comes back.
3. `cls` is `read` (GET), `write` (changes dashboard records) or `operational` (acts on equipment or services
   outside the dashboard). A read-only token is not even offered the non-read tools. A `DELETE` tool must say
   `destructive: true`. Delete tools are added only where a person could not mistake the effect; there are none for
   tickets, wiki pages or accounts.
4. Remove the matching `pending` rule from `route-rules.ts` in the same change. The coverage test
   (`apps/api/test/mcp-coverage.test.ts`) fails on a route that is neither a tool nor covered by a rule, on a rule
   that no route needs any more, and on a pending rule of a finished phase.
5. A result larger than 60,000 characters of JSON is cut to the items that fit, with `total`, `shown` and a hint to
   narrow the query. If a list can be large, give the tool filters and a `limit`.
6. Text in results (ticket and wiki bodies, comments, device names) is written by other people; the server
   instructions tell the agent to treat it as data. Do not add a tool that returns a stored secret.

The seven wiki tools stay hand-written in `mcp.tools.ts` (they need the optimistic-lock and audit shapes there).

## Excluded on purpose

Listed with reasons in `route-rules.ts` (`excluded`); the main groups:

- **Session-only**: backups and restores, API token management, password and email change, TOTP, sign-in.
- **Secrets as arguments**: the "test connection" routes of every integration.
- **No undo, or too powerful**: host OS updates (sudo password), hard-delete and password-set for accounts.
- **Admin writes** (users, groups, settings): read-only admin for now.
- **Binary attachments** (upload and download): need their own design (multipart; return a link for downloads).
- **Plumbing**: probes, metrics, internal sign-in calls, mail and reindex operations.

## Operational token level (phase 3)

A third token level beside "read-only" and "read and write": `read` < `write` < `operational`. It is enforced where tokens
already are, not just in MCP, otherwise a write token could call the same route over REST:

- additive migration: `api_tokens.allow_operational boolean not null default false` (old code ignores it);
- a `@OperationalOnly()` route decorator (like `@SessionOnly()`), checked in `SessionGuard` for bearer requests;
- the create form and `ApiTokenSummary` carry the level; `scopeUserToToken` is unchanged;
- existing tokens get `false`, so nothing that worked for a script over REST changes except the routes marked
  operational, which are listed in the phase 3 rules.

## Known limits

- In a cluster, a client without the read-your-writes cookie can see its own write about a second late if the
  load balancer sends the next call to another node (documented for all token clients in CLAUDE.md).
- Tool count: the full catalogue will be a lot of tools. `tools/list` already shows each token only what it may use,
  so a token limited to a few modules sees a small set. If the full list proves too much for clients, add a
  `toolset` filter to the token (modules already do most of this).

## Tests

- `apps/api/test/mcp-coverage.test.ts`: every route covered, permissions mirrored, schemas build, names sane.
- `apps/api/test/mcp-bridge.test.ts`: URL/body building, error text, result cutting, the route call itself (fake inject).
- `apps/api/test/mcp-tools.test.ts`: the service, the wiki tools, listing per caller, and the SDK client over HTTP.
- `tests/smoke/mcp.mjs`: real tokens against the live stack (session refused, listing per token, a bridge tool end to end,
  read-only refusal).
