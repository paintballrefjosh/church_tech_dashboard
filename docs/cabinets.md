# Cabinets (racks) and printable port sheets

Added 2026-10-25. **IT > Cabinets** (`/cabinets`) records where each Cisco switch, infrastructure host, UniFi device and
custom item sits in a server or network cabinet, draws it as an elevation (front and rear), and prints it. The Cisco switch
page and the UniFi device list each have a printable port sheet. Part of the `monitoring` module: anyone who can see
monitoring reads (`monitors:read:any`), the monitoring admin tier changes (`monitors:write:any`), like IPAM, DNS and UPS.
Nothing here talks to a device: placing an item only changes this dashboard's record.

## Cabinets

- `racks` (name, location, `units` 1-60, default 42, notes) and `rack_items` (migration 0075). Several cabinets are allowed.
- **U1 is the bottom.** An item is `startU` (the lowest U it fills) and `heightU`; `startU: 10, heightU: 2` fills U10 and U11.
  All the arithmetic (fits, overlap, first free slot, rows top to bottom, a height suggested from a picture) is pure code in
  `packages/shared/src/rack-layout.ts`, tested in `apps/api/test/rack-layout.test.ts`. The API refuses a place that does not fit
  or overlaps (409, in words), inside a transaction that first touches the cabinet row so two nodes placing at once take turns.
- **An item is one of:** `cisco` (a switch, by id), `infra` (a host, by id), `unifi` (a device, by MAC) or `custom` (patch panel,
  PDU, UPS, shelf, blanking panel ... with a name, optional hostname and IP, and a `style` that decides how it is drawn).
  A linked item stores only a pointer plus a snapshot (`label`, `hostname`, `ip`); the page shows the **device's own** name,
  address and status (`RacksService.withLive`), and its edit cannot rename it. There is deliberately **no foreign key** to the
  source: a UniFi device is a MAC the controller reports, and a deleted device must not silently empty a place. A device that has
  gone shows "not found" and keeps its place; a UniFi controller that cannot be reached is **not** "not found" (the snapshot
  shows). A device sits in one cabinet only (409 otherwise; `GET /racks/candidates` says where each already is).
- UniFi devices are read through a 15 s `TtlCache` with a 3 s deadline and a 20 s failure memory, so a dead controller costs one
  short wait, not one per page view.
- Routes: `GET|POST /racks`, `GET /racks/candidates`, `GET|PATCH|DELETE /racks/:id`, `POST /racks/:id/items`,
  `PATCH|DELETE /racks/:id/items/:itemId` (audited `rack.*`). A cabinet cannot be made smaller than its highest item.
  MCP: `racks_list`, `racks_get` (reads); writes and the candidate picker are excluded in `route-rules.ts` with reasons.
- Backup: both tables are `data` in the Monitoring section (`table-registry.ts`).

## Pictures

A cabinet item's picture is a **device profile** (the same admin data as the Cisco switch view: a front and a back picture,
`switch_models`, on the Device profiles page, `/device-profiles`). Which profile: the one picked on the item ("Pictures" in the
form: any profile for any item), else the one the device itself resolves to (`resolveSwitchView`): the profile chosen for it (a
Cisco switch in its Edit form, an infra host in its form, a UniFi device with the "Picture" button in Monitoring > Network
(UniFi)), else a profile whose match text appears in the device's model (UniFi `US48PRO`; an infra host has no model text, so only a
chosen profile counts), unless the device's picture was turned off. `apps/web/src/lib/rack-pictures.ts`. The rear view uses the model's back picture. No picture
= a drawn stand-in by `style` (CSS only: nothing to print but ink). The height in the form is suggested from the picture's
proportions (a 19" panel is 482.6 x 44.45 mm per U) and is only a suggestion.

**Add-on modules** (the C3KX-NM-10G in a 3750-X, see [switch-faceplates.md](switch-faceplates.md#add-on-modules-migration-0072)) are
drawn on the cabinet picture and the port sheet picture the way the switch page draws them: a placement is drawn while the
switch reports one of the module's ports, and only on the side the model keeps its ports on (that is the picture the module was
placed on). The cabinet reads the switch's port names from the API (`live.portNames`, Cisco only; the names in `cisco_ports`),
`installedModules` (`lib/faceplates/custom.ts`, unit-tested) decides which placements count, and `RackElevation` draws them in
an SVG with the picture so the module stays on its bay whether the picture is stretched or fitted to the slot.

## Printable pages

All three are plain `<article>` sheets with no top bar (`A4 portrait`, `@page` margin 10 mm, `print-color-adjust: exact`, shared
rules in `apps/web/src/lib/print-css.ts`); the person chooses and presses Print. They stay white in dark mode. Checked as real
PDFs: a 42U cabinet is one page (front, or front and rear); a 48-port sheet is two with the heading repeated.

- `/cabinets/<id>/print`: the cabinet (Front, Rear or Front and rear, "Pictures" off for a plain drawing) with a **table beside it
  whose rows are the cabinet's rows** (same grid, same `--u`): U, hostname (or name), IP address, level with the item drawn next to
  it. A test measures that the two line up (`cabinets.spec.ts`).
- `/print/cisco/<switch id>` and `/print/unifi/<mac>`: a picture of the device at the top (Front or Back, the person's choice; it
  starts on the side with the ports) with the ports numbered on it when the model has port boxes for that side, then a table of
  every port: description, VLAN, subnet. Data: `GET /port-sheets/cisco/:id` and `/port-sheets/unifi/:mac` (read-only, MCP tools
  `port_sheet_cisco`, `port_sheet_unifi`). The row rules are `ciscoSheetRows` and `unifiSheetRows` in
  `packages/shared/src/port-sheet.ts` (tested in `port-sheet.test.ts`).
  - **Cisco:** an access port shows `10 Staff` and the subnet(s) of that VLAN; a trunk shows its native VLAN and either the tagged
    VLANs (up to six, each with its subnet) or "all VLANs" / "N tagged VLANs". VLAN names come from the switch's own VLAN list
    (`cisco_vlan_db`); **subnets come from IPAM** (`ipam_subnets.vlan_id`, this switch's own SVIs first). A VLAN with no subnet
    there prints "-" and the sheet says so in a note: put the VLAN number on the subnet on the IPAM page.
  - **UniFi:** a port's network comes from its profile (`rest/portconf`, a per-port override wins) and the network's VLAN and subnet
    from `rest/networkconf` (`UnifiService.portProfiles()` / `networkConfs()`, read-only, `null` when the controller cannot be asked,
    in which case the sheet leaves VLANs blank and says why). "All" profiles print "all networks tagged". A per-port name is the
    description (UniFi's default "Port 7" is not).
- Entry points: "Printable page" on the Cisco switch page header, "Print ports" on each UniFi device that has a port table
  (Monitoring > Network (UniFi)), "Printable page" on a cabinet.

## Pictures for infrastructure hosts and UniFi devices (built 2026-10-25, migration 0081)

- **Infra host:** `infra_targets.switch_model_id` (no "off" column: a host has no model text, so no picture = no profile). Chosen
  in the host form ("Picture"), shown as a card with the front and back on the host page (`components/device-picture.tsx`).
- **UniFi device:** `unifi_device_views (mac, switch_model_id, switch_view_off)`, because the devices are not rows here; "automatic"
  is no row. `PUT /unifi/devices/:mac/switch-view` with the same body as Cisco (`setSwitchViewSchema`), from the "Picture" column of
  the devices table (writers only; `unifi-picture-dialog.tsx`, with a preview). It works while the controller is down and sends
  nothing to it.
- Both go through `checkDeviceProfile` (`apps/api/src/switch-models/check-profile.ts`: the profile exists and is not an add-on
  module), and deleting a profile clears the choice (foreign key, ON DELETE SET NULL). The cabinet and the UniFi port sheet read
  the UniFi choices live (`UnifiService.deviceViews()`), not through the few seconds' cached device list, so a choice shows at once.

## Tests

`apps/api/test/rack-layout.test.ts`, `port-sheet.test.ts` (pure), smoke `tests/smoke/cabinets.mjs` (the API on the live stack:
placing, overlaps, one cabinet per device, linked items keep the device's name, the sheets), e2e `tests/e2e/tests/cabinets.spec.ts`
(fake API through `page.route`; the elevation, the placement form, the print sheets, axe on each; `SHOTS=<folder>` saves screenshots).
