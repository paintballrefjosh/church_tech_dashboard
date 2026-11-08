# Module settings live in the module

Plan, 2026-11-08. Status: decisions made; shared groundwork (G1-G4) built and Signage converted (2026-11-08); modules not yet moved. Signage (migrations 0091/0092) is the worked example.

Goal: **Admin is for the site and its people** (accounts, groups, sign-in, mail, backups, cluster, audit, security). Anything that
configures one module moves to that module's own pages, gated by that module's admin tier, and disappears from `/admin`, the Admin
menu and the command palette.

## 0. Who can do what (decided 2026-11-08)

The existing tiers, unchanged: **site admin** (the `admin` group) can do everything; per module, **admin** can do everything inside
that module, **moderator** has limited modification rights, **user** is the baseline for normal use.

- A module's settings page and its configuration (credentials, integrations, limits, templates it owns) need the module's **admin** tier. A site admin has it everywhere.
- A **moderator** keeps the day-to-day changes the module already gives them (add and edit content, acknowledge, check out). They do not see the settings page, or see it read-only where that is useful (no secrets).
- A **user** never sees settings.
- Rule for deciding where a setting lives: **if only one module uses it, it is that module's setting and its admin edits it. If other parts of the site depend on the integration, it is a site setting and only site admins edit it.** (This replaces the old "site:read" categories for module-only things.)

## 1. The pattern (what Signage does)

1. Pages `/<module>/settings` (and `/<module>/security` when there is a second group), linked from the module's tab row or header, not from Admin.
2. The values are still `KNOWN_SETTINGS` rows. Only the **category** and the page that edits them change. Keys never change, so no data migration.
3. `SETTING_CATEGORY_MANAGE_PERMISSION[category]` still decides who may read and write them over the API (module admin permission).
4. Secrets are masked on the server before they reach the page (`loadModuleSettings`: `********` when saved).
5. A "Test connection" button posts to a route inside the module, not to an `admin` route (`/api/settings/test/<target>`).
6. Module-specific panels (key rotation, releases, mailbox status) sit on the same page, under the form.

## 2. Shared groundwork (do first, once)

**Done 2026-11-08 (G1-G4):** `components/settings-form.tsx` (the form, saves to `/api/settings/save/[key]`, tests to `/api/settings/test/[target]`),
`lib/load-module-settings.ts` (`loadModuleSettings(keys)`), `components/module-settings.tsx` (`ModuleSettingsPage`, `SettingsSection`,
`SettingsFormSection`; server-renderable, because a page passes a lucide icon and a component cannot cross into a client component) and
`components/settings-nav.tsx` (client; the links between a module's settings pages). Signage's two pages use them (`signage/settings/nav.ts`
holds its nav as plain data); the Admin category page and its two panels use the new save route. The old `/admin/settings/save` and
`/api/admin/test` routes are gone. Checked: `make rebuild`, `signage.spec.ts` (with its axe scans) and `helpdesk.spec.ts`.
A client file cannot export plain values to a server page (it gets a reference, not the value): keep nav data in a `.ts` file.


| # | Change | Why |
|---|---|---|
| G1 | Move `SettingsForm` (and its `save/[key]` route) from `app/admin/settings/` to `components/settings-form.tsx` + `app/api/settings/save/[key]` | Signage imports it from the admin folder today; the admin folder must be deletable per category |
| G2 | Generalise `loadSignageSettings` into `lib/load-module-settings.ts` (`loadModuleSettings(keys)`) | Every module needs the same masked load |
| G3 | A `ModuleSettingsShell` (title, optional sub-nav like `SettingsSubnav`, section boxes) | One look for every module's settings page |
| G4 | Move the Test-connection proxy to a module-neutral route (`/api/settings/test/[kind]`) with the same `ROUTES` map | Today the URL says `admin` |
| G5 | `Settings` entry in each module's tab row / header, shown when the viewer has the module admin permission | Discoverability (Signage's tab row is the model) |
| G6 | Remove module entries from `topbar-nav.tsx` `MODULE_ADMIN_ITEMS`, `/admin` `CARDS` (section `modules`), `lib/palette.ts`, `SETTINGS_CATEGORIES` (`section: "module"`) | Admin becomes site-only; the hub then needs no "Modules" section |
| G7 | Redirects in `next.config.mjs` from every old `/admin/...` address to the new one (as was done for `/monitoring/ipam*`) | Bookmarks, emails and notices already link to the old paths |
| G8 | Update the strings that name the old place: `mailer.service.ts`, `assistant.service.ts`, `auth.controller.ts`, signin page hint, `apps/api/src/main.ts` comment, empty-state links in module pages (list in section 4) | Users are told where to go |
| G9 | Tests: `zz-accessibility.spec.ts` page lists (`/admin/settings`, `/admin/assistant`, `/admin/planning-center`), `helpdesk.spec.ts` (`/admin/settings/helpdesk`), `assistant.spec.ts` (`/admin/assistant`) | They hard-code the old addresses |
| G10 | CLAUDE.md: replace the "Module settings" memory with a rule under Conventions; note each module's new settings page in its section | Keep the context file current |

## 3. Per module: what moves

"Gate" is the permission that should authorise the category after the move (see decisions D1).

### 3.1 Helpdesk (tickets) -> `/tickets/settings`
| Item | From | Notes |
|---|---|---|
| Ticket categories | `/admin/ticket-categories` | Page already exists; relink and redirect |
| SLA targets (`tickets.sla.*`, 9 keys incl. warn %) | `site` category | Category `tickets` |
| Tickets from email (`tickets.inbound.*`, 11 keys) + mailbox status panel | `helpdesk` category, `/admin/settings/helpdesk` | `HelpdeskEmailPanel` moves with it. This is an IMAP mailbox the helpdesk READS; outgoing mail already uses the site-wide SMTP (`MailQueue`) and stays there. Only the helpdesk uses it, so the Tickets admin edits it (D2). Needs a host check first, see D2 |
| Saved replies | already `/tickets/canned-replies` | Link from the settings page |

### 3.2 Wiki -> `/wiki/settings`
| Item | From | Notes |
|---|---|---|
| Review interval default (`wiki.review.default_days`) | `site` category | Category `wiki` |
| Templates | already `/wiki/templates` | Link from the settings page |

### 3.3 Monitoring (IT menu) -> `/monitoring/settings`, with IPAM, DNS, UPS parts on their own pages
The `monitoring` category (39 keys) is the biggest. Split by where the setting acts:
| Item | Keys | New home |
|---|---|---|
| Collector tick and concurrency | `monitoring.tick_seconds`, `poll_concurrency` | `/monitoring/settings` |
| History retention | `monitoring.history_retention_days` (now in `site`) | `/monitoring/settings` (it prunes only monitoring history) |
| Maintenance mode | `monitoring.maintenance_*` | Already has a control on the tab row; keep the settings-page row as a link |
| Alerts: flapping, reminders, escalation group, status notice, public status | `ALERT_KEYS.*` | `/monitoring/settings` "Alerts" section, next to the existing Alerts tab |
| UniFi controller (url, key, site, protect, guest SSID, TLS, offline alert) | `unifi.*` | `/monitoring/network/settings` (Test connection moves too) |
| DNS (primary, token, TLS, unreachable alert, sync zone/PTR/TTL, stale days) | `dns.*` | `/dns/settings`; the "DNS admin" button in `dns/layout.tsx` points here |
| IPAM scan (enable, interval, concurrency, timeouts, lookups, TCP ports) | `monitoring.ipam_*` | `/ipam/settings`; the "IPAM admin" button in `ipam/layout.tsx` points here |
| UPS defaults (SNMP version, community, timeout, interval) | `monitoring.ups_*` | `/monitoring/ups/settings` or a section of the UPS tab |
| Cisco | none in settings today | Nothing to move |
Each group needs its own category (`unifi`, `dns`, `ipam`, `ups`, `monitoring`) in the catalogue so the form lists only its keys; all keep `monitors:write:any`.

### 3.4 Printers -> `/printers/settings`
`printers.*` (default SNMP version and community, timeout, poll interval, Fiery timeout), plus its Test connection. Gate `printers:admin`.

### 3.5 ProPresenter -> `/propresenter/settings`
`propresenter.host/port/password` and Test connection. Today the page links to `/admin/settings/propresenter` in two places (`page.tsx`, `propresenter-client.tsx`). Gate `propresenter:admin`.

### 3.6 Planning Center -> `/planning-center/settings`
| Item | From |
|---|---|
| App id, secret, default service type | `/admin/settings/planning_center` |
| User links (map local users to PC people) | `/admin/planning-center` (becomes a section or sub-page `/planning-center/links`) |
Three links to fix in `planning-center/page.tsx` and one in `dashboard-tiles/tiles.tsx`. Gate `planning_center:admin`.

### 3.7 Checklists -> `/checklists/manage` (or `/checklists/settings`)
All of `/admin/checklists` moves: templates (new, `[id]`), services (new, `[id]`), stations, events/new, reports. There are no `KNOWN_SETTINGS` rows. This is the largest page move, not a settings move. Gate `checklists:admin`. Link in `checklists/page.tsx` to update; roughly a dozen files under `admin/checklists` carry `/admin/checklists` hrefs.

### 3.8 Livestreams -> `/livestreams/settings`
`livestreams.*` keys (YouTube, Twitch, Facebook, Resi, max concurrent samples). Already module-gated; only the page moves. Gate `livestreams:admin`.

### 3.9 Signage
Already done. Needs only G1-G3 so it stops importing from the admin folder.

### 3.10 Assistant -> `/assistant/settings` (+ `/assistant/usage`)
| Item | From | Notes |
|---|---|---|
| Provider, URL, key, model, limits, budget, retention (16 keys) and `AssistantPanel` (test connection, privacy notice, readiness) | `/admin/settings/assistant` | See D3: it sends site data to an outside service |
| Usage and feedback page | `/admin/assistant` | Gate `assistant:usage` today |
`assistant.spec.ts` and the readiness code both name the old address.

### 3.11 Equipment (assets) and Rooms
No settings today. Nothing to move. Reserve `/assets/settings` for the first one.

### 3.12 Left in Admin on purpose (decision D4)
Home page defaults and the time zone (`dashboard.*`, `site.timezone`), the audit, notification and activity retention windows, upload types (`attachments.*`), the push switch (`notifications.push_enabled`) and the monthly report switches (`reports.monthly_*`).

## 4. What stays in Admin (site-wide, not one module)

Users, Groups, Tags (shared by tickets, notes, wiki), API tokens, Permission matrix, Audit log (+ `audit.retention_days`), Security overview, Cluster, Backups (+ offsite), Reindex, and the settings categories `site` (name, URL, tagline, footer, time zone), `auth`, `google`, `microsoft`, `smtp`, `experimental`, plus `attachments.*` (upload policy shared by wiki, notes and tickets).

Result: `/admin/settings` lists Site, Authentication, Google, Microsoft, SMTP, Experimental only. The "Modules" section of `/admin` and the Modules group of the Admin menu go away.

## 5. Decisions

- **D1 Authority (decided).** The tier model in section 0. Categories that only one module uses are managed by that module's admin permission, including the ones that were site-only (SLA, wiki review, reports, mailbox).
- **D2 Helpdesk mailbox (decided: Tickets admin edits it).** It is incoming IMAP for ticket creation, nothing to do with SMTP: sending stays on the site SMTP and the helpdesk never has its own outgoing settings. Condition: `ticket-inbound.ts` connects to whatever host is typed, with no address check (no loopback, link-local or container-name refusal like the livestream, DNS and service-monitoring code). Add that check (`assertFetchableHost`-style, also after DNS) in the same change that hands the page to a Tickets admin.
- **D3 Assistant (do as first proposed for now).** Page in `/assistant/settings`, edit rights stay with site admins, because the assistant sends wiki, ticket and live-system content to an outside provider. Revisit: nothing else on the site depends on the provider, so by the rule in section 0 it may become module-admin-editable. That needs a decision on the privacy acknowledgement (it is recorded per destination) and on the "Assistant" module's admin tier (it has no `assistant:admin` permission today, only use, usage and history).
- **D4 Borderline site-wide items (decided: stay in Admin).** Home page defaults, `site.timezone`, retention windows, `attachments.*`, and `notifications.push_enabled`. Section 3.12-3.15 are therefore dropped as moves; 3.14 (monthly report switches) stays a candidate only if you say so.
- **D5 Checklists (decided).** A tab row under `/checklists`, like Signage's.

## 6. Suggested order

1. G1-G4 (shared pieces), then convert Signage onto them.
2. Small, already module-gated: Printers, ProPresenter, Livestreams, Planning Center (settings + links).
3. Helpdesk (SLA, categories, mailbox) and Wiki, Reports, Notifications.
4. Monitoring split (UniFi, DNS, IPAM, UPS, alerts), the biggest settings change.
5. Assistant, then Checklists (largest file move).
6. G6-G10 cleanup last, removing the Modules section from Admin and the old redirects' sources.

Each step ends with: old address redirects, links and tests updated, `make rebuild`, accessibility sweep, one commit.
