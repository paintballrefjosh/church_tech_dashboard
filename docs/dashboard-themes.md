# Home dashboard themes: implementation plan

Status: **planned** (2026-10-10). Nothing below is built yet.

The five concepts in [`docs/dashboard-concepts/`](dashboard-concepts/index.html) become selectable
looks for the home page (`/`), alongside today's tile grid. Each signed-in person picks the one they
like. An admin sets the site default and which looks are offered. A booth screen can pin its own.

| Id | Name | Mockup so far | Needs | Signature |
|---|---|---|---|---|
| `tiles` | Tiles | light and dark (exists) | nothing | Today's draggable grid, unchanged |
| `start` | Start page | light | nothing | Written summary, search, one "Needs you" list with in-place actions |
| `nave` | Nave | dark | nothing | The sign-in arches as the hero; arched panels |
| `toward-sunday` | Toward Sunday | light | nothing | Mon to Sun rail with "now", "Ready for Sunday" score |
| `glass` | Glass | light | `monitors:read:any` | Stained-glass uptime mosaic (system x hour) |
| `front-of-house` | Front of House | dark | `monitors:read:any` | Channel strips with live meters, maintenance mode as mute |

**Every look works in both light and dark mode.** The "mockup so far" column only says which scheme the
concept was drawn in first; each look gets its other scheme designed and built in its own phase (see
decision 4).

## Decisions

These shape everything below. Each one can be changed, but the plan assumes them.

1. **The current grid stays, as the `tiles` look.** Saved layouts (`dashboard_layouts`) keep working,
   `tests/e2e/tests/dashboard.spec.ts` keeps passing, and anyone who customised their grid loses nothing.
   The new looks are composed pages, not drag-and-drop grids. They can hide optional sections (phase 7)
   but cannot be rearranged.
2. **One data layer, six renderers.** A single endpoint, `GET /api/v1/dashboard/home`, returns everything
   the home page shows as a typed snapshot. Each look is purely presentation over that snapshot. No look
   fetches its own data or holds business rules (what counts as "needs you", what "ready" means). Adding or
   fixing a rule fixes every look at once.
3. **Choosing a look, in order of precedence:** a `?theme=` URL parameter (preview, never saved) beats a
   per-device cookie ("use on this device only", for the booth PC), which beats the person's saved choice,
   which beats the site default (`dashboard.default_theme`). A look the person cannot use (no monitoring
   access for Glass or Front of House), or that the admin has switched off, falls through to the next
   one. The final fallback is `start`, which works for everyone.
4. **Every look works in both light and dark mode. This is a requirement, not a polish item.**
   - The scheme follows the app's existing theme setting (light, dark or system, through `next-themes`
     and the `.dark` class), the same as every other page. A look never forces its own scheme, and
     switching the theme toggle on the home page restyles it at once, without a reload.
   - Each look defines two complete token sets, under `[data-look="<id>"]` and `.dark [data-look="<id>"]`:
     background, surfaces, text, lines, accents and status colours, plus its signature (arch strokes and
     glow, glass shades, LED and screen colours, rail tints). Contrast meets WCAG AA in both.
   - The scheme that is not mocked up yet is designed, not inverted: a mockup goes into
     `docs/dashboard-concepts/` (for example `2-nave-light.html`) and is reviewed before it is built.
     Starting points: Start page dark is slate night with the brand periwinkle; Nave light is "daylight
     nave" (pale stone, indigo arches, the same warm light); Toward Sunday dark is navy night with the
     marigold "now"; Glass dark sets the window on a dark page and lets the panes glow brighter, with
     the leaded panes going deep slate; Front of House light is a "daylight console" (light grey
     hardware, same LED colours, a dark scene screen kept as a screen).
   - The top bar on `/` follows the look in both schemes (its `appearance` has a light and a dark style).
   - **A phase is not done until its look is built, screenshotted and covered by e2e in both schemes**,
     on desktop and at 390 px.
5. **No new write endpoints for the home page except the preference.** In-place actions (acknowledge a
   device, take a ticket, tick a checklist task, mute alerts) call the existing audited routes, so the
   audit trail and permission checks are the ones that already exist.
6. **Nothing is faked.** The mockups contain invented details (a run sheet, a bass player button, meter
   jitter). In the build, every figure maps to a real field, and a section whose data is missing,
   unconfigured or forbidden is left out, never filled with placeholders.
7. **The church's time zone becomes a setting** (`site.timezone`, IANA name). "Good evening", "today",
   the week rail's day boundaries and hourly buckets need it. Today the app has none: backups carry their
   own zone, and checklist services use the container's clock (`checklists.service.ts` `setHours`).
   Moving checklists onto the new setting is a separate, later change.
8. **Themes only change the home page.** Every other page keeps the app's own style. On `/` the top bar
   takes an `appearance` from the look (transparent over Nave's hero, console-grey for Front of House).

## Architecture

```
                         page.tsx (server)
   auth, /me, resolve look (URL > cookie > pref > default > fallback)
   fetch GET /api/v1/dashboard/home?include=<what this look needs>
                                 |
            <HomeRoot look=... snapshot=...>   next/dynamic: only the chosen look's code and fonts load
     tiles | start | nave | toward-sunday | glass | front-of-house
                                 |
           useHomeSnapshot(initial, include)
           refresh: realtime signal (monitoring, infra, user:{id}) or 30 s poll, on focus,
           and on the existing `monitoring:health-refresh` window event
                                 |
                  GET /api/v1/dashboard/home  (DashboardModule)
   sections built in parallel, each with its own timeout and permission gate:
   service | systems | needs | tickets | checklists | wiki | notes | activity
   + optional: week | availability | meters
   each section = { state: "ok", data } | { state: "unconfigured" | "unavailable" | "forbidden" }
```

### Snapshot contract (`packages/shared/src/dashboard/home.ts`)

Zod schemas, shared by api and web. Sketch:

```ts
type Section<T> =
  | { state: "ok"; data: T }
  | { state: "unconfigured" | "unavailable" | "forbidden"; reason?: string };

interface HomeSnapshot {
  generatedAt: string;               // ISO
  timezone: string;                  // site.timezone
  dayPart: "morning" | "afternoon" | "evening";
  user: { id: string; firstName: string };
  site: { name: string; tagline: string };
  service: Section<NextService>;     // Planning Center plan, or the next checklist event as fallback
  systems: Section<SystemsHealth>;   // areas (servers, internet, wifi, switches, dns), problems, maintenanceMode
  needs: Section<NeedItem[]>;        // ranked, cross-module
  tickets: Section<TicketDigest>;    // mine, unassigned count, SLA due times
  checklists: Section<ChecklistDigest>;
  wiki: Section<WikiDigest>;         // recently changed, ACL-filtered
  notes: Section<NotesDigest>;
  activity: Section<ActivityItem[]>;
  week?: Section<WeekDigest>;               // include=week (Toward Sunday)
  availability?: Section<AvailabilityGrid>; // include=availability (Glass)
  meters?: Section<SystemMeters>;           // include=meters (Front of House)
}
```

`NextService` carries the plan, its times **with their type** (`rehearsal` / `service` / `other`, which
the run sheet needs; `planDetail` does not return `time_type` today), and the team grouped by position
with confirmed / waiting / declined counts.

`NeedItem` is `{ id, kind, severity: "urgent" | "soon" | "normal", title, context, href, dueAt?,
actions: Action[] }`, where an `Action` names an existing endpoint the web may call (see phase 2).

### Section rules

| Section | Gate (permission strings) | Source | Cache per node |
|---|---|---|---|
| service | `planning_center:read:any`, else `checklists:read:assigned` for the fallback | `PlanningCenterService.listUpcomingPlans` + `planDetail`; `checklist_events` | 5 min (PC rate limit) |
| systems | `monitors:read:any`; the UniFi area also needs `unifi:read:any` | `MonitorsService.summary`, infra summary, `UnifiService.summary`, `cisco_switches`, `DnsService.summary`, `monitoring.maintenance_mode` | UniFi 15 s, DNS 60 s |
| needs | per source, same as that source | tickets (assigned to me, SLA due), open problems, declined/unconfirmed positions, my open checklist tasks | inherits |
| tickets | `tickets:read:own` / `tickets:read:any` | `TicketsService` + `ticketSlaStatus` and the SLA settings | none |
| checklists | `checklists:read:assigned` | `ChecklistsService.myOpenTasks` | none |
| wiki | `wiki:read:own` / `wiki:read:any` | `WikiService` list (applies page ACLs) | none |
| notes | `notes:read:own` | `NotesService` | none |
| activity | any signed-in user, filtered like `/activity` | `ActivityService.list` | none |

- Sections build in parallel with a **2.5 s timeout each**. A slow UniFi controller makes `systems` come
  back partially (`unavailable` on that area), never the whole page.
- Caches are small per-node TTL maps with single-flight (one refresh in flight per key), the same idea as
  `SettingsService.get`. They only cache reads of external systems, so they never need cluster-wide
  invalidation.
- **Do not subscribe the home page to the `network` room.** `UnifiPoller` polls the controller and pushes
  full snapshots whenever that room has viewers, so every open home page would turn on the busiest poller.
  The home page reads the cached summary instead.
- The pure rules live in `packages/shared/src/dashboard/` and are unit-tested in isolation: `rankNeeds`,
  `computeReadiness`, `summarize` (Start page's sentence, as typed tokens so the web renders links),
  `buildWeek`, `bucketAvailability`, `resolveLook`, and `zoned.ts` (day boundaries in a zone, using
  `Intl.DateTimeFormat`; no new dependency).

### Look preferences

- Migration `0056_dashboard_prefs.sql` (additive): `dashboard_prefs (user_id uuid PRIMARY KEY REFERENCES
  users ON DELETE CASCADE, theme text NULL, sections jsonb NOT NULL DEFAULT '{}', updated_at timestamptz
  NOT NULL DEFAULT now())`. `theme NULL` means "use the site default". A separate table, rather than a
  column on `dashboard_layouts` (whose `layout` is `NOT NULL`, so a theme-only row would freeze today's
  default layout) or on `users` (which would drag the user cache and `CACHE_ROOM` into a home page
  preference).
- `GET /api/v1/dashboard/prefs` and `PUT /api/v1/dashboard/prefs` in `DashboardController`, audited as
  `dashboard.prefs.update` (unlike layout drags, a look change is a deliberate, rare action). Web route
  handlers in `apps/web/src/app/api/dashboard/{home,prefs}/route.ts` via `forwardToApi`, like
  `api/dashboard/layout/route.ts`, so the read-your-writes cookie is relayed.
- Settings (`KNOWN_SETTINGS`, category `site`): `site.timezone` (string, default `UTC`; the settings form
  validates it with `Intl.supportedValuesOf("timeZone")`), `dashboard.default_theme` (string, default
  `tiles` during rollout), `dashboard.enabled_themes` (json array, default all six),
  `dashboard.stream_monitor_ids` (json array of monitor ids for the "Stream" readiness check; empty
  means the check is left out).
- Backups: `dashboard_prefs` is `data` in group `SETTINGS` in `backup/table-registry.ts`.
- Device cookie `church_home_look` (`HttpOnly`, `SameSite=Lax`, no `Secure`, per the HTTPS-upstream
  rule), set by a tiny web route when "Use on this device only" is ticked; read in `page.tsx`.

### Web layout

```
apps/web/src/app/page.tsx                  resolve look, fetch initial snapshot, render HomeRoot
apps/web/src/app/home/
  resolve-look.ts                          server side; calls shared resolveLook
  home-root.tsx                            next/dynamic switch over the six looks
  use-home-snapshot.ts                     client refresh logic (above)
  parts/                                   behaviour without styling: Countdown, NeedActions (calls
                                           the existing endpoints, optimistic, with undo), TeamCounts,
                                           SearchField (extracted from command-palette.tsx), QuickCreate
  picker/look-picker.tsx                   drawer: thumbnails, live preview, "this device only"
  looks/tiles/                             wraps the existing app/dashboard-tiles/ (left in place)
  looks/start/  looks/nave/  looks/toward-sunday/  looks/glass/  looks/front-of-house/
```

- Each look scopes its tokens under `[data-look="<id>"]` and `.dark [data-look="<id>"]` as CSS variables,
  with Tailwind for layout. Fonts come from `next/font/google` (self-hosted at build, so no requests to
  Google at runtime) and are imported only inside that look's module. Families: Archivo (with the `wdth`
  axis), Marcellus + Karla, Albert Sans, Barlow + Barlow Condensed, Figtree.
- The top bar gets `appearance: "default" | "overlay" | "console"`; only `/` passes anything but the default.
- `TopBar` and the existing `DashboardBackdrop` stay as they are for `tiles`. The new looks have no canvas
  backdrop: their hero is the signature.
- Motion: one orchestrated moment per look, all behind `prefers-reduced-motion: no-preference`.

## Phases

Sizes are relative: S, M, L. Each phase ends deployable, with the site default still `tiles` until phase 7.
For the order they can run in, and which ones run side by side, see [Working in parallel](#working-in-parallel).
The settings keys, migrations, registry entries, schemas and stubs listed under the phases below are
created up front in that section's contracts step; each phase then fills in its own part.

### Phase 0: groundwork (S)

- `packages/shared/src/dashboard/themes.ts`: `DASHBOARD_LOOKS` catalogue (id, name, description,
  required permissions, snapshot `include`s, a light and a dark thumbnail) and `resolveLook()`.
- Settings above; migration 0056; registry entry; prefs endpoints and web routes.
- `page.tsx` resolves the look and renders `HomeRoot`; only `tiles` exists, so nothing changes visibly.
- Look picker: a "Change look" item next to "Customise" opens a drawer with a thumbnail per available
  look (for now the concept screenshots, copied to `apps/web/public/home-looks/`), switches immediately,
  and offers "Use on this device only". The same choice appears on `/me` (display section) and the
  admin settings page (default, enabled looks, time zone).
- Spike: confirm a `next/font` import inside a `next/dynamic` client module only ships that look's font
  CSS. If not, fall back to declaring all families in one module with `preload: false`.
- Tests: unit (`resolveLook` precedence and fallbacks, zone helpers across DST changes, registry test
  passes), smoke (prefs round trip, audited, unknown theme rejected), e2e (picker switches and persists
  across reload; the device cookie wins over the saved choice; `?theme=` previews without saving).
- The picker shows each look's thumbnail in the scheme the person is using now.
- Done when: an admin can set the default, a person can pick, the booth PC can pin, and `tiles` renders
  exactly as today in light and dark.

### Phase 1: home snapshot API (M)

- `apps/api/src/dashboard/home/`: `home.controller.ts` (`GET /dashboard/home?include=`),
  `home.service.ts`, `sections/*.ts` (one file per section), `cache.ts`. `DashboardModule` imports the
  feature modules; export their services where they are not exported yet (watch for circular imports;
  use `forwardRef` only if needed).
- `PlanningCenterService.planDetail` returns `timeType` and `name` for each plan time.
- Shared schemas and pure rules (`rankNeeds`, `summarize`, `zoned`) with unit tests.
- `useHomeSnapshot` and the `parts/` components.
- Tests: unit for every rule; smoke for shape and gating (the regression user without monitoring gets
  `systems: { state: "forbidden" }` and no monitoring needs); a smoke case with Planning Center
  unconfigured (`service` falls back to the next checklist event, or `unconfigured`).
- Done when: the endpoint answers in under 500 ms warm on the dev stack, a stalled UniFi controller costs
  at most 2.5 s and only that area, and the snapshot validates against its schema in a test.

### Phase 2: Start page (M)

- Look from `5-start-page.html`: greeting by `dayPart`, the summary sentence from `summarize()` with
  linked tokens, the search field (the existing `/api/search` and the result list extracted from
  `command-palette.tsx`), create chips, "Needs you" grouped "Before Sunday" / "This week", side column
  (next service, systems, recent pages).
- In-place actions, each calling an existing route and offering undo:
  - Acknowledge a device: `POST /unifi/devices/:mac/ack`, undo `DELETE` (shown with `monitors:write:any`).
  - Take a ticket: `PATCH /tickets/:id { assignedUserId: me }`, undo sets it back (shown only where the
    ticket page would let this person assign).
  - Reply, Start checklist, Open in Planning Center: links, not actions.
- "Pick up where you left off" uses the person's own recent wiki and note edits from `activity_events`.
  View history is not recorded today, and this plan does not add it.
- Both schemes: mockup the dark one first (`docs/dashboard-concepts/5-start-page-dark.html`), then build
  light and dark together.
- Tests: e2e renders, acknowledge-then-undo round trip against a configured or stubbed source (the e2e
  suite must not ack real devices: branch on configuration like the smoke suite does), no horizontal
  overflow at 390 px, keyboard path through Needs you.

### Phase 3: Nave (S to M)

- Extract the arch geometry from `apps/web/src/app/signin/chapel-window.tsx` into
  `components/nave-arches.tsx`, used by both sign-in and this look, so the two stay identical.
- Hero (service, countdown, team count, plan and checklist buttons) over the arches, top bar `overlay`.
  The three arched panels (Systems, Sunday's team, For you), then the quieter row (activity, wiki,
  create). The site tagline closes the page.
- Without a next service, the hero says good evening and shows the summary sentence instead.
- Both schemes: mockup the light one first ("daylight nave": pale stone, indigo arches, the same warm
  light), then build light and dark together. The arch colours come from the look's tokens, so the shared
  `nave-arches.tsx` must take them as props rather than hard-code the sign-in page's colours.
- Tests: e2e renders in both schemes; reduced motion shows the arches at rest with no animation.

### Phase 4: Toward Sunday (M to L)

- `include=week` builds `WeekDigest` for Monday to Sunday in `site.timezone`: per day up to three events
  (plus "n more") from `monitor_incidents` (opened, how long), tickets opened and SLA due times,
  `checklist_events` (stations signed off), Planning Center plans, finished backups
  (`backup_operations`), and wiki changes (`activity_events`). Each day also gets 24 hourly health cells,
  computed from incidents overlapping each hour (monitors and infra targets). Phase 5 swaps in the
  availability table, which also covers Wi-Fi and switches.
- `computeReadiness()`: Systems (no area down), Team (no declined, waiting counted), Stream (the monitors in
  `dashboard.stream_monitor_ids` are up; check omitted when unset), Run-through (the latest checklist
  event in the 7 days before the service has every station signed off), Help desk (no urgent or high
  ticket past its response SLA). Checks whose source the person cannot see are omitted, and the score
  is out of what remains.
- Rail with the "now" marker (placed by the zone-aware time; it travels in once on load), Sunday column
  with service times, readiness strip, lower row. On phones the rail scrolls inside its card, starting
  at today.
- Both schemes: mockup the dark one first, then build light and dark together.
- Tests: unit for `buildWeek` (DST weeks, events at midnight, empty days) and `computeReadiness` (each
  check, omitted checks); e2e renders.

### Phase 5: availability history and Glass (L)

- Migration `0057_availability_hourly.sql`: `availability_hourly (kind text, ref text, hour timestamptz,
  label text, samples int NOT NULL, down int NOT NULL, PRIMARY KEY (kind, ref, hour))` plus an index
  on `hour`. Kinds: `monitor`, `infra_target`, `unifi_device`, `cisco_switch`, `dns_node`.
- `AvailabilitySampler` registered with `ClusterJobs` as `availability-sample`, every 60 s fixed-rate:
  reads the current state of every system (monitor and infra target status; UniFi devices through the
  cached service read; `cisco_switches.reachable`; DNS nodes) and adds one sample per system to the
  current hour with `INSERT ... ON CONFLICT (kind, ref, hour) DO UPDATE SET samples = ... + 1, down =
  ... + $n` (portable to CockroachDB and YugabyteDB). It prunes rows older than 8 days in batches with
  `WHERE (kind, ref, hour) IN (SELECT ... LIMIT 500)`, never `DELETE ... LIMIT`. One sampler covers every
  kind the same way, instead of changing each poller and the separate monitor worker. Sampling once a
  minute is fine for hourly panes.
- `ClusterJobs` already skips runs during a restore. In `table-registry.ts` it is `rebuilt("Hourly
  availability")`.
- `include=availability`: systems x last 12 hours. A pane is lit (no down samples), partial (some), dark
  (all), or empty (no samples yet, e.g. the first hours after upgrading).
- The look: the mosaic is a CSS grid of spans (about 700). Pane shade comes from a hash of `ref`, so it is
  stable across loads, and the light sweeps in once on load. Hover shows "name: up, 3 h ago". For
  assistive tech the mosaic is one `role="img"` with a written summary, and the group labels under it
  are the links (so there are not 700 tab stops). Then the leaded grid of panes for service, needs, create
  and wiki.
- Toward Sunday's daily strips switch to this table (they then include Wi-Fi and switches).
- Both schemes: mockup the dark one first, then build light and dark together.
- Tests: integration for the upsert and prune on CockroachDB **and** YugabyteDB (`TEST_DATABASE_URL`,
  one integration file at a time); unit for `bucketAvailability`; a sampler test with fake sources; e2e
  renders and the tooltip appears on hover.

### Phase 6: Front of House (M to L)

- `include=meters`, one honest reading per channel, each with its scale written down next to the code:
  - Servers: average CPU and memory over enabled targets from the latest `infra_metric_samples` (last
    5 min). The infra summary has no averages today.
  - Internet: median latency of the latest check of each `http`/`icmp` monitor (`monitor_checks.latency_ms`).
  - Wi-Fi: clients (`UnifiService.summary().clients.total`) and access points online.
  - Switches: ports up (`cisco_port_live_state`) and drift events in the last 24 h (`cisco_drift_events`).
  - DNS: queries per minute from `DnsService.stats` (last hour), and the last sync time.
- The meters move only when a new reading arrives (every 15 s), with a short settle animation. The
  mockup's idle jitter is decoration and is dropped. Reduced motion: no animation.
- Master strip: total up, the last few alerts (from `monitor_incidents` and the UniFi offline list),
  "Mute alerts" = maintenance mode through the existing `GET/POST /monitors/maintenance` (shown with
  `monitors:write:any`, otherwise a read-only state), and Ack on a channel through the existing route.
- Scene screen: service, show clock (counts down to the first `service` time), run sheet from the plan
  times. Team as an input list. "Your checklist" ticks tasks in place via the existing
  `PATCH /checklists/event-tasks/:taskId`.
- Kiosk: `/?theme=front-of-house&kiosk=1` hides the nav and search for a booth screen (the session is
  still required).
- Both schemes: mockup the light one first ("daylight console"), then build light and dark together.
- Tests: unit for each meter's scaling; e2e for mute and ack round trips (only where configured, never
  against real devices in the shared suite: stub or branch like the smoke suite); kiosk hides the chrome.

### Phase 7: sections, polish, rollout (M)

- Hide or show the optional sections of each look (`dashboard_prefs.sections`, keyed by look id), from a
  "Sections" tab in the picker. The signature never hides.
- Accessibility pass on every look x scheme: axe in e2e, contrast checks on the token sets, focus rings,
  keyboard paths.
- Replace the picker thumbnails with screenshots of the real looks (light and dark), taken with the
  Playwright harness.
- Performance: home page served in under 600 ms p95 on the dev stack; only the chosen look's JS and
  fonts load (checked in the build output).
- Docs: a "Home dashboard looks" section in CLAUDE.md (the contract: snapshot, sections, rules in shared,
  "nothing is faked", how to add a look), and an admin note in INSTALL.md (default look, time zone, stream
  monitors, booth screens).
- Choose the default (see open questions), then flip `dashboard.default_theme`.

## Working in parallel

The phases are numbered for reading, not as a strict sequence. After a short serial "contracts" step,
the work runs in three waves:

```
Contracts (serial, S)
    |
    +-- Wave A, in parallel ------------------------------------------------+
    |     Phase 0   prefs, settings, resolver, picker, HomeRoot             |
    |     Phase 1   snapshot API, useHomeSnapshot, shared parts             |
    |     Phase 5a  availability table + sampler (backend only)             |
    |     Mockups   the five missing schemes (design only, no code)         |
    +-----------------------------------------------------------------------+
    |
    +-- Wave B, in parallel, each in its own folder ------------------------+
    |     Phase 2   Start page                                              |
    |     Phase 3   Nave                                                    |
    |     Phase 4   Toward Sunday (+ include=week, computeReadiness)        |
    |     Phase 5b  Glass (+ include=availability)                          |
    |     Phase 6   Front of House (+ include=meters, kiosk)                |
    +-----------------------------------------------------------------------+
    |
    +-- Wave C, serial
          Toward Sunday's day strips move to the availability table; Phase 7
```

**Contracts step.** One change, done first, that fixes every shared surface so the parallel branches
only add their own files and never edit the same lines:

- The complete snapshot schema in `packages/shared/src/dashboard/home.ts`, including the `week`,
  `availability` and `meters` shapes. Their builders come later, but their types are fixed here.
- The `DASHBOARD_LOOKS` catalogue with all six entries, the `LookProps` type, and `resolveLook`.
- Every new `KNOWN_SETTINGS` key (`site.timezone`, `dashboard.default_theme`, `dashboard.enabled_themes`,
  `dashboard.stream_monitor_ids`).
- Both migrations (0056 `dashboard_prefs`, 0057 `availability_hourly`), their Drizzle schema files and
  both `table-registry.ts` entries, generated together so the drizzle journal is written once. Two
  branches that each generate a migration conflict in `migrations/meta/`.
- `home-root.tsx` mapping all six ids, with a stub `looks/<id>/index.tsx` in each folder, so a look branch
  replaces its own stub and never touches the map.
- A section registry in `apps/api/src/dashboard/home/sections/index.ts` that already lists every
  section and `include`, each pointing at a stub returning `unavailable`, so Phases 1, 4, 5b and 6 each
  fill in their own file.
- One e2e spec file per look (`tests/e2e/tests/home-<id>.spec.ts`), so the test changes don't collide
  either.

**What really has to wait:**

| Work | Waits for | Why |
|---|---|---|
| Any look (Wave B) | Phases 0 and 1 merged | Looks render inside `HomeRoot`, read the snapshot through `useHomeSnapshot` and use the shared parts (countdown, need actions, team counts, search field) |
| Glass UI (5b) | 5a running for a while | The mosaic needs 12 hours of samples to look like anything. Running 5a in Wave A means real history exists when the UI lands |
| A look's build in both schemes | Its missing-scheme mockup reviewed | Decision 4 |
| Toward Sunday on availability data | Phases 4 and 5a | Swaps the incident-based day strips for the table |
| Phase 7 | Everything | Section hiding, the accessibility pass and the real thumbnails cover all six looks |

**The real bottleneck is verification, not coding.** Type checks and unit tests run in a container per
branch, so they parallelise freely. But the dev host has one live stack on :8100, and the e2e suite and
the screenshot harness both run against it. So branches **merge one at a time**: rebuild, run the
regression suite, screenshot both schemes, then the next. A throwaway stack per branch (as
`tests/cluster/sim.sh` does, on its own ports and data) removes that queue, at the cost of a full stack
per branch on this host. Wave B's merge order follows Wave A's dependencies only loosely, so any finished
look can go next.

**Practicalities:**

- Parallel branches mean git branches or worktrees and commits. Worktrees start from the last commit, so
  uncommitted changes in the main checkout are not in them. Commit or stash those first.
- Shared parts belong to Phase 1. A look that needs a new shared behaviour adds it in its own folder
  first and promotes it later, rather than editing `parts/` in parallel.
- Wave sizes: Wave A is four streams, Wave B five. Each Wave B stream is a look plus, for three of them,
  its own API section.

## Cross-cutting rules this plan must keep

- **Cluster:** the sampler is a `ClusterJobs` job (leased, one node). Snapshot caches are per node and
  only cache external reads. The prefs write goes through `forwardToApi`, so the read-your-writes cookie
  makes the next page load on any node see it. No bare `setInterval` in the API.
- **Migrations** 0056 and 0057 are additive (expand/contract): the previous release runs fine against
  them.
- **Portable SQL** only (no `UPSERT`, `DELETE ... LIMIT`, row TTL); wrap `count(*)` in `Number()`.
- **Audit:** prefs updates audited; actions reuse audited routes; no bypass.
- **Backups:** both new tables in `table-registry.ts` (the registry test fails otherwise).
- **Installer:** no new `.env` setting, so `install.sh` is unchanged. Everything new is in `settings`.
- **No emoji, no `any`,** zod on both sides.

## Testing matrix

| | tiles | start | nave | toward-sunday | glass | front-of-house |
|---|---|---|---|---|---|---|
| Admin, light and dark, desktop and 390 px | e2e | e2e | e2e | e2e | e2e | e2e |
| Theme toggle switched on the home page (restyles without reload) | e2e | e2e | e2e | e2e | e2e | e2e |
| Regression user (limited groups) | e2e | e2e | e2e | e2e | falls back to start | falls back to start |
| Planning Center unconfigured | n/a | e2e | e2e (hero fallback) | e2e (hero fallback) | e2e | e2e |
| Reduced motion | n/a | n/a | e2e | e2e | e2e | e2e |

Plus the screenshot harness for a visual check of each cell before a phase is called done. The e2e suite
never acknowledges real devices, mutes real alerts or ticks real checklists on the shared dev stack: those
cases run only against fixtures it creates itself, or are skipped when the integration is configured.

## Risks

- **Six looks to maintain.** Mitigation: rules in shared, data in one snapshot, looks are presentation
  only, and the e2e matrix above catches a look that broke.
- **Load on outside systems** (UniFi controller, Technitium, Planning Center's rate limit) as more people
  keep the home page open. Mitigation: per-node caches, no `network` room subscription, 30 s refresh.
- **Snapshot latency** from many sections. Mitigation: parallel builds, per-section timeouts, optional
  `include`s so each look asks only for what it shows.
- **One scheme getting less care than the other.** Mitigation: a mockup of the missing scheme before it is
  built, two complete token sets per look, and both schemes in every phase's definition of done.
- **Fonts** (seven families). Mitigation: the phase 0 spike; only the chosen look's fonts load.

## Open questions

1. **Default look once all six exist?** Suggestion: `start` for everyone (it works with any access), and
   people who run Sunday pick Front of House or Toward Sunday themselves.
2. **Should admins be able to set a default per group** (for example Front of House for `support_engineer`)?
   Not in this plan. It would be one more setting and a resolver step.
3. **Stream readiness:** which monitors represent "the stream"? If there is no stream encoder monitor yet,
   the check stays hidden until one is added and listed in `dashboard.stream_monitor_ids`.
