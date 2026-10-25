# Rooms and the asset inventory

Two features that share one list of places: **rooms** (one list used by tickets, assets, cabinets, monitors, infra hosts and
printers, each with a "report a problem here" QR sign) and **assets** (the equipment a church tech team keeps in a
spreadsheet: mics, IEMs, cameras, laptops, cables; with check-out, labels and import from a spreadsheet).

Decided with Josh on 2026-10-25:

- **Anyone checks out to themselves.** Every account in the default `user` group can see the inventory and check an item out
  to, or back in from, themselves (by scanning its label). Staff check out to other people (or to someone without an account,
  by name), add and edit items. Cost and purchase date are shown to staff only.
- **Rooms are managed by the Assets admin tier and site admins.** Everyone signed in reads them (a ticket form needs the list).
- **The cabinets' free-text location becomes rooms.** The migration makes one room per distinct text and links each cabinet;
  the old column stays for a release (expand/contract) and is kept equal to the room's name. A Cisco switch's `location` is NOT
  converted: it is the switch's own `snmp-server location`, compared with the running config and pushed, not a place in this
  app. A switch is in a room through its cabinet.

## Access

A new module `assets` (group editor: "Assets"):

| Tier | Brings | Can |
|---|---|---|
| user | `assets:read:any`, `assets:checkout:own` | see the inventory and rooms' assets, check out to and return from themselves |
| moderator | `assets:write:any` | add and edit items, check out to anyone (or a name), return anything, see cost, purchase and history |
| admin | `assets:admin`, `locations:admin` | delete items, import from a spreadsheet, add/rename/remove rooms |

Defaults: `user` group = user, `support_engineer` = moderator, `admin` = everything (as for every module). Migration 0082 adds
the two grants to existing installs when those groups exist. Reading rooms needs only a session (no permission string), like
`/status`.

## Rooms (`locations`)

- `locations`: `name` (unique), `building` (free text, groups the list), `notes`. The API path is `/locations`, the page
  `/rooms`; the word in the UI is "room".
- `location_id` (FK, ON DELETE SET NULL) on `tickets`, `racks`, `monitors`, `infra_targets`, `printers` and `assets`. Deleting a
  room clears those links; the page says how many first.
- **The room page (`/rooms/<id>`) shows only what the reader may see**: assets (`assets:read:any`), cabinets, monitors and hosts
  (`monitors:read:any`), printers (`printers:read:any`) and open tickets the reader can read (their own, or all with
  `tickets:read:any`). One route, `GET /locations/:id/summary`, assembles it with the same gates; a section the reader may not see
  is absent, not empty.
- **"Report a problem here"**: the room page and its printed sign link to `/tickets/new?room=<id>`, which opens the ticket form
  with the room chosen. The QR code is an SVG made by the print page on the server (`apps/web/src/lib/qr.ts`, `qrcode` 1.5.4, the
  version the API already uses for TOTP) from the address the page was opened at (`X-Forwarded-Host`/`-Proto`), so no host name is
  baked in: print signs from the address people will scan. Scanning needs a sign-in like any page: there is no anonymous ticket form.
- **Cabinets**: the cabinet forms pick a room; the API keeps `racks.location` equal to the room's name (create, update, a room
  rename, and "" when the room is removed). The `locations-adopt` cluster job (at start, then every 6 hours) makes a room for each
  cabinet that still has text and no room, so an older node writing text is picked up too.

## Assets

- `assets`: `tag` (unique, e.g. `A-0042`; blank = next number from `assets_tag_seq`), `name`, `category` (closed list:
  audio, video, lighting, computer, network, cable, instrument, furniture, other), `make`, `model`, `serial`, `location_id`,
  `status` (`in_service`, `in_repair`, `retired`, `lost`), `lendable` (installed kit such as a projector is not checked out),
  `purchased_on`, `cost`, `warranty_until` (date-only strings on the site calendar, as renewals), `notes`.
- `asset_checkouts`: `asset_id`, `holder_user_id` or `holder_name` (someone with no account), `out_by_user_id`, `out_at`,
  `due_on` (date, optional), `returned_at`, `returned_by_user_id`, `note`, `reminded_for`.
- **One open check-out per asset is the database's rule**: a partial unique index on `asset_checkouts(asset_id) WHERE
  returned_at IS NULL` (CockroachDB and YugabyteDB both have partial indexes). Two people scanning the same label at once: one
  insert wins, the other gets 409 "already checked out to ...". Returning is a conditional UPDATE on `returned_at IS NULL`.
- A check-out needs the item `in_service` and `lendable`. To yourself: `assets:checkout:own`. To someone else: `assets:write:any`.
  Returning: the holder, or `assets:write:any`.
- **Overdue reminders**: the hourly `asset-overdue` cluster job finds open check-outs whose `due_on` has passed and CLAIMS each by a
  conditional UPDATE of `reminded_for` (the due date), then tells the holder and whoever checked it out (kind `asset.overdue`).
  One notice per due date; changing the due date starts again. A check-out more than 30 days overdue when first seen is
  flagged silently (turning the feature on must not announce history). Rules are pure functions in `schemas/asset.ts`.
- **Tickets**: `tickets.asset_id` (FK, ON DELETE SET NULL). The asset page has "Report a problem with this" (`/tickets/new?asset=<id>`,
  room filled in too) and lists the tickets about it that the reader can read.
- **Labels**: `/print/assets?ids=...` prints a sheet of labels (QR to `/assets/<id>`, tag, name) on white, like the other print
  pages. Scanning a label opens the asset page with "Check out to me" or "Return" at the top.
- **Import from a spreadsheet** (`/assets/import`, `assets:admin`): a CSV is read in the browser by the pure `parseAssetCsv`
  (headers matched by name, any order, unknown columns ignored, each row checked and its problems listed), previewed, then sent
  as JSON to `POST /assets/import` (at most 2000 rows, one transaction, all or nothing; a room named that does not exist is
  created when the admin ticks "create missing rooms", otherwise the row is refused). Duplicate tags are refused with the row number.
- **Search**: kind `asset` (tag and name as the title; make, model, serial, category and room as the body; never the cost), gated by
  `assets:read:any`, reconciled with the other database-backed kinds on their timer (`ASSET_KINDS`, `loadAssetDocs`). An item or
  room write calls `SearchService.assetsChanged()`, which brings this node's equipment documents in line at once; other nodes
  follow within `SEARCH_MONITORING_SYNC_MS`.
- **Who sees what**: cost and purchase date only with `assets:write:any`; check-out history (who had it) with `assets:write:any`;
  everyone with read sees the current holder and due date (that is what makes "where is the wireless mic?" answerable).
- **Retention**: returned check-outs older than 3 years are removed by `RetentionService` (an item's history matters, but not
  forever).
- **MCP**: read tools for assets and rooms, create/update tools for assets and rooms; check-out and return are excluded (a
  person's own action at the item, done by scanning), as are deletes and import.
- **Backups**: `locations`, `assets`, `asset_checkouts` are `data` in a new "Assets and rooms" section; `reminded_for` is
  volatile. A Helpdesk-only restore writes a ticket's room or item empty when it no longer exists (both links are optional).

## Where the code is

API `apps/api/src/assets/` (`LocationsService`, `AssetsService`, controllers for `/locations` and `/assets`), migration 0082, rules
and parsing in `packages/shared/src/schemas/{asset,location}.ts`. Web: `/assets` (list, `[id]`, `import`), `/rooms` (list, `[id]`),
`/print/assets`, `/print/rooms/[id]`, shared pieces in `components/assets-ui.tsx` (`RoomField`, `RoomSelect`, `useViewer`). The menu
calls the module "Equipment"; the group editor calls it "Assets". Tests: `apps/api/test/assets.test.ts`, smoke `tests/smoke/assets.mjs`,
e2e `tests/e2e/tests/assets.spec.ts` and the accessibility sweep.

## Not built

- Booking an item for a future date (a reservation calendar). Check-out is "it is with this person now".
- Depreciation, purchase orders, suppliers.
- Rooms on checklist stations and Cisco switches (see above).
- Booking rooms (that is Planning Center's job, and Phase 4).
