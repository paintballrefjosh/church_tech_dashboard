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

A cabinet item's picture is a **switch model** (the same admin data as the Cisco switch view: a front and a back picture,
`switch_models`). Which model: the one picked on the item ("Pictures" in the form: any model for any item), else for a Cisco
switch the one its own page resolves to (`resolveSwitchView`), else a model whose match text appears in the device's model
(UniFi `US48PRO`, infra has none). `apps/web/src/lib/rack-pictures.ts`. The rear view uses the model's back picture. No picture
= a drawn stand-in by `style` (CSS only: nothing to print but ink). The height in the form is suggested from the picture's
proportions (a 19" panel is 482.6 x 44.45 mm per U) and is only a suggestion.

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

## Planned (asked for 2026-10-25, not built)

Let people attach a front and back picture to **infrastructure hosts and UniFi devices** the way the Cisco switch page does
(a "Picture" choice in each device's edit form: automatic, a switch model, or none). The seams are in place: everything that
draws a device goes through `pictureModelFor` (`rack-pictures.ts`), and a cabinet item can already point at any model. What is
missing is a place to store the choice for those two kinds (a `switch_model_id` / `switch_view_off` pair on `infra_targets`, as
on `cisco_switches`, migration 0071; a small table keyed by MAC for UniFi, whose devices are not rows) and the picker in their
forms. The UniFi print sheet matches the model text only until then.

## Tests

`apps/api/test/rack-layout.test.ts`, `port-sheet.test.ts` (pure), smoke `tests/smoke/cabinets.mjs` (the API on the live stack:
placing, overlaps, one cabinet per device, linked items keep the device's name, the sheets), e2e `tests/e2e/tests/cabinets.spec.ts`
(fake API through `page.route`; the elevation, the placement form, the print sheets, axe on each; `SHOTS=<folder>` saves screenshots).
