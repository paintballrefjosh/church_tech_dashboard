# MCP: the whole app for agents

Plan, rules and status for making everything the web app can do (with a few deliberate exceptions) available
through the MCP server at `/api/v1/mcp`. Decided 2026-10-12. Operator docs: INSTALL.md "Connecting Claude (MCP)".

## Status

| Phase | Scope | State |
|---|---|---|
| **0. Bridge** | In-process route bridge, tool catalogue, route-coverage test, per-caller tool listing, smoke tests | **done** |
| **1. Work content** | Tickets and categories, notes, tags, saved views, activity, notifications, own notification settings, the home snapshot, checklists; wiki gaps (old revisions, revert, page access, folder rename/move) | **done** |
| **2. Monitoring and IT** | Monitors (create, update, maintenance mode), service health, hosts (infra), UniFi (read, acknowledge a device), printers, UPS, IPAM, DNS, Cisco (read), Planning Center, ProPresenter status | **done** |
| **3. Operational** | Anything that acts on live equipment or feeds it: ProPresenter slides, switch ports and pushes, DNS records and sync, polls, scans, and IPAM edits (they start scans and publish names to DNS). Needs the new "operational" token level | |
| **4. Read-only admin** | Users, groups and module access, settings (secrets hidden), audit log, cluster status | **done** |

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

The ten wiki tools (the original seven plus `wiki_backlinks`, `wiki_needs_review` and `wiki_list_templates`, all reads) stay hand-written in `mcp.tools.ts` (they need the optimistic-lock and audit shapes there).

## Decisions made in phase 1

- **No delete tools** for tickets, ticket categories, notes (archive instead), tags, saved views, wiki pages and folders,
  or any checklist object. The two deletes that exist are small and per-person: dismissing a notification and taking
  someone off an event position (`destructive: true`). `POST /tickets/bulk` accepts a delete action on the route; the
  tool's schema simply leaves it out.
- **The home page's layout and look** are personal UI state and stay in the web app; `dashboard_get_home` returns the
  data the home page shows (what needs attention, service health, own tickets and tasks).
- Query arrays are sent repeated (`?status=a&status=b`); a route that wants one comma-separated value says so with
  `commaKeys` on the tool (search `kind`, home `include`, checklist template `ids`).
- `wiki_create_page` now takes `visibility` and `acl`; `wiki_set_page_access` changes them on an existing page.

## Decisions made in phase 2

- **Devices are registered in the web app, not by agents.** Creating or editing an infra host, printer, UPS or Cisco switch
  carries an address and a login (SSH, SNMP, API token); a changed address would also send the stored login somewhere
  else. Agents read them and can switch monitors on or off, nothing more.
- **Credentials the read routes return are hidden.** A tool can name `redact` keys (`BridgeTool.redact`); the bridge
  replaces their values with `[hidden]` before the model sees them. Used for the SNMP community on printers and UPS
  units, and for a monitor's stored `Authorization` header. `monitors_update` replaces the whole `options` object, so
  its description tells the agent to leave `options` out when the header shows as hidden.
- **Monitors can be created and changed, not deleted** (disable one instead). Maintenance mode is a write tool; its
  description says to switch it back off.
- **IPAM writes wait for phase 3**: adding or adopting a subnet starts a scan, and the subnet's DNS switch and a host's
  DNS name publish records to live DNS. Same for the Cisco desired-port and VLAN edits (`cisco_set_vlan`; they are what gets pushed to a switch).
- **Cisco config backups can be read** (`cisco_get_backup`; the description warns that a running config can hold hashes
  and community strings). The route gives the same text to anyone with the monitoring module.
- `cisco_lookup` and `cisco_list_mac` keep the route's `exclude_uplinks` parameter as the strings `"0"` and `"1"`;
  Planning Center plans keep `service_type_id`. A tool's argument names follow the route's, not a prettier style.

## Decisions made in phase 3

- **The operational level is enforced on the routes, not just in MCP**, so a write token cannot call the same route over
  REST. Routes carry `@OperationalOnly()`; the list is whatever the coverage test finds with that decorator, and each one
  is either an `operational` tool or an excluded route with a reason (DNS record delete, host OS updates).
- **Class of each tool.** Pushing to a switch, shutting a port, re-baselining a switch, running the DNS sync and updating a
  DNS record are `destructive`. Accepting or dismissing Cisco drift only changes the dashboard's own records, so those are
  ordinary `write` tools.
- **Desired port configuration and IPAM edits are operational** even though the route itself only writes the database:
  what they set is later pushed to a switch or published to DNS.
- **No DNS record delete tool** (still no delete tools); the REST route is operational-only.
- Existing tokens get the level off. A script that used one of these routes over REST needs a new token.

## Decisions made in phase 4

- **Settings secrets are hidden for agents even from a site admin.** The route shows a secret in the clear to anyone who can
  manage the category (right for a person at a form). The two settings tools run `hideSecretSettings` (`bridge/scrub.ts`):
  a secret that is set reads `[hidden]`, and so does any key the catalogue does not know (it may be one). This is the
  `BridgeTool.transform` hook, for what a key list (`redact`) cannot say.
- **The audit log is scrubbed twice.** A row's snapshot is the route's answer, and not every route strips its secrets from it (a
  monitor create stored its `Authorization` header). `AuditService.write` now runs `scrubSnapshot` (`audit/audit-scrub.ts`) on
  `before` and `after` of every row, so no route needs to remember `redactKeys`; a one-time job (`audit-scrub-backfill`) rewrote the
  rows stored earlier. `audit_list` still runs `scrubAudit` over what it returns, as a second layer. Both hide strings and objects
  under a credential-looking key; numbers, booleans, null and empty values stay, as do identifier keys (`tokenId`, `prefix`).
- `settings_list` and `settings_get` have no `@RequirePermissions` on the route (the handler decides per category), so
  every token sees them in `tools/list`; a caller without settings access gets an empty list or a 403.
- No admin writes: users, groups, settings, token management, backups and node removal stay in the web app.

## Attachments

Built after phase 4: `tickets_`, `notes_` and `wiki_` each get `list_attachments`, `get_attachment` and `add_attachment` (9 tools, `catalogue/attachments.tools.ts`,
`bridge/attachments.ts`). They are still doors onto the existing routes, so the allowed-types setting, the magic-byte check, the 10 MiB cap, page and ticket access
and the audit row (with the token id) all apply unchanged. A tool opts into bytes with `binary: "download" | "upload"`; the coverage test treats it like any other tool.

- **Reading** (`get_attachment`): the answer is a description (name, type, size) and, where a model can use the file, the file: an image (png, jpeg, gif, webp, up to
  5 MiB) as an MCP image block, a text file (`text/*`, JSON, XML, YAML, CSV) as text cut at 60,000 characters. Anything else (PDF, Office, archives, custom
  extensions stored as opaque downloads) is described only, with a note to open it in the web app. No download link is issued: that would need an unauthenticated
  route, and the backup download link is the only one of those the app has. The description carries a warning that a file's content is data, not instructions.
- **Adding** (`add_attachment`): `text` (UTF-8, default type `text/plain`) or `contentBase64` with a `contentType`, at most 1 MiB decoded, because the model has to
  write the bytes itself. The bridge wraps it as one multipart `file` part and calls the upload route. A bigger file, or one on disk, goes the ordinary REST way:
  the upload routes accept the same bearer token (`curl -H "Authorization: Bearer $TOKEN" -F file=@report.pdf .../api/v1/tickets/<id>/attachments`).
- **No delete tool** (same rule as tickets and wiki pages). A new file is added each time; nothing is overwritten.
- The audit row for an upload names the attachment as its resource (the interceptor prefers the response's `id` over the route parameter), with the token id.

## Excluded on purpose

Listed with reasons in `route-rules.ts` (`excluded`); the main groups:

- **Session-only**: backups and restores, API token management, password and email change, TOTP, sign-in.
- **Secrets as arguments**: the "test connection" routes of every integration, and registering or editing a device.
- **No undo, or too powerful**: host OS updates (sudo password), hard-delete and password-set for accounts.
- **Admin writes** (users, groups, settings): read-only admin for now.
- **Deleting an attachment**, like deleting a ticket or a wiki page. Listing, reading and adding files are tools (see "Attachments" below).
- **Wiki import** (`POST /wiki/import`): a multipart upload of a whole archive.
- **Plumbing**: probes, metrics, internal sign-in calls, mail and reindex operations.

## Operational token level

Built in phase 3 (migration 0058). A third token level beside "read-only" and "read and write": `read` < `write` < `operational`. It is enforced where tokens
already are, not just in MCP, otherwise a write token could call the same route over REST:

- additive migration: `api_tokens.allow_operational boolean not null default false` (old code ignores it);
- a `@OperationalOnly()` route decorator (like `@SessionOnly()`), checked in `SessionGuard` for bearer requests;
- the create form and `ApiTokenSummary` carry the level; `scopeUserToToken` is unchanged;
- existing tokens get `false`, so nothing that worked for a script over REST changes except the routes marked
  `@OperationalOnly()`.
- the create form offers "Read, write and equipment"; a read-only token cannot have the level (the schema refuses it).

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
