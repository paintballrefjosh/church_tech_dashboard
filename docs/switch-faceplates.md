# Switch faceplates (the "switch view")

The Cisco switch page (`/monitoring/network-cisco/switches/<id>`) opens on a picture of the switch seen from the front,
with a button over every port. Hovering a port (or focusing it, or tapping it) shows its details with Edit, Delete and
Shut down / Enable. A "Switch view | List view" toggle at the top right, beside the Rows selector, goes back to the
table; the choice is remembered per browser (`church.portView` in localStorage, `usePortView`). A model with no
faceplate gets the table and no toggle. On the switch list, hovering a row with the mouse shows a card beside the
pointer with that switch's picture and its ports coloured by state, plus the colours in words ("12 up, 35 enabled, no link, 5 shut
down"); it follows the pointer and flips to stay in the window (`network-cisco/switch-hover-preview.tsx`, `FacePreview` and
`faceSummary` in `switch-faceplate.tsx`). Nothing on it can be pressed and it is hidden from screen readers: the row already says the
port counts in words, and the switch's page has the full, keyboard-usable view. Ports are read on the first hover of a switch and reused
for 30 s; a switch with no picture gets no card. The UniFi device page uses the same pieces (see the end).

## Pieces

| File | What it is |
|---|---|
| `apps/web/src/lib/faceplates/layouts.ts` | The library: one `FaceplateLayout` per model (panel size, photo path, every port's box), `faceplateForModel(model)`, and `ciscoSlotFor(portId, layout)` (an interface name to a slot on the panel). Pure, tested in `layouts.test.ts`. |
| `apps/web/src/components/switch-faceplate.tsx` | The picture + port buttons + popover. Knows nothing about Cisco: it takes `FaceItem`s (id, slot, label, state) and a `renderDetails` function. |
| `apps/web/src/components/port-view-toggle.tsx` | `usePortView` and `PortViewToggle`. |
| `.../switches/[id]/page.tsx` | Builds the items (`faceItems`, `faceState`) and the popover body (`PortDetails`). Edit/Delete reuse the list's form and confirm dialog. |

## Device profiles (admin, in the app)

The code and the database call them switch models (`switch_models`, `SwitchModel`); the UI calls them **device profiles** since 2026-10-25,
because they also draw UniFi devices, infra hosts and cabinet items. The normal way to add one: **IT > Device profiles** (`/device-profiles`;
the old `/monitoring/*/models` addresses redirect there). Reads need
`monitors:read:any`, changes `monitors:write:any` (the monitoring admin tier). On a switch's page an admin also gets a link:
"Set up a profile for this model" (opens the create form with the model text filled in) or "Edit <profile>".

- A model (`switch_models`, migration 0070; shared schema `packages/shared/src/schemas/switch-model.ts`) has a name, **match
  strings** (a switch whose reported model contains one, in any case, uses it; the longest string wins, then the first by
  name: `matchSwitchModel`), a **front and a back picture**, which side the **ports are on**, and one box per port.
- Pictures are PNG, JPEG or WebP, up to 8 MB, stored as `attachments` (parent type `switch_model`) so backups and the object
  store already cover them. The API reads the pixel size from the file's own bytes (`image-size.ts`) and never trusts the
  browser's type. A replaced picture is a new attachment id and URL (`?v=<id>`), so the day-long cache never shows a stale one.
  `switch_models.front_image_id/back_image_id` are foreign keys with `ON DELETE SET NULL`: a restore of part of the data leaves
  a model with no picture, not a broken one.
- A port box is `{name, aliases, kind, x, y, w, h}` with the position as a **fraction of the port-side picture** (so it does
  not depend on how big the picture is drawn). `name` is the interface as the switch calls it (`Gi1/0/7`, `Eth1/7`, a UniFi
  port number); `aliases` are other names for the same socket (a cage that is `Gi1/1/1` or `Te1/1/1`). A name belongs to one
  port only (case-insensitive); the schema and the editor both refuse duplicates. The other side's picture is shown by the
  "Show the back / front" button, without boxes.
- A model that matches wins over the built-in layouts below; a built-in is the fallback for a model nobody has set up.

### Which model draws which switch

Decided in the browser by `resolveSwitchView` (`lib/faceplates/custom.ts`, tested in `custom.test.ts`), in this order:

1. **An admin turned the picture off** for this switch (`cisco_switches.switch_view_off`): ports are listed only.
2. **An admin picked a model** for this switch (`cisco_switches.switch_model_id`, migration 0071, `ON DELETE SET NULL`, so deleting
   the model puts the switch back on automatic). It beats any text match. A pick that cannot be drawn yet (no picture on its
   port side, or no ports) draws nothing; it does not quietly fall back to something else.
3. **The model text** the poller read (`show inventory` PID, e.g. `N3K-C3064PQ-10GX`) contains one of a model's match strings
   (case-insensitive, strings under 2 characters ignored; the longest string wins, then the first by name).
4. **The built-in drawing** for a few Cisco models, else nothing (list view only, no toggle).

The switch page says which of these happened in one line under the header (`SwitchViewLine`: "Switch view: Cisco Nexus 3064PQ,
matched on "C3064PQ" in the model text N3K-C3064PQ-10GX", "chosen for this switch", "No switch model matches ...",
"has not reported its model yet") for everyone who can read it, with a link for an admin (`monitors:write:any`) to edit the model
in play or to set one up for this model text. The choice itself is made in the **Edit switch** form (the button right of "Add port" on a
switch's page, and "Edit" on the switches list; one shared `SwitchFormModal`, `network-cisco/switch-form.tsx`): a "Switch view" picker
("Automatic (match the model text)", "Use <model>" for each model, "No switch view (list only)") with a live sentence under it saying
what the model text typed in the form would match. It saves through `PUT /cisco/switches/:id/switch-view` after the switch itself, and
only when the choice changed (`{mode: "auto" | "model" | "off", modelId?}`, audited `cisco.switch.view`, display only: nothing is sent
to the switch, so it is not operational-only; MCP-excluded). The choice is on the switch row, so a restore of the Monitoring section
carries it.

Layout of the page: the "Switch view | List view" toggle is at the top right of the picture; under the picture the legend is on the left
and, on the right, the "Show the back / front" button (when the model has a picture of the other side). In list view the Rows selector is
bottom left on the pagination row (`DataTable rowsSelector="footer"`; other tables keep it at the top).

### Importing pictures from a stencil, a PowerPoint file or a picture

**Import from a file** (on the Device profiles page, and on a model's own page for that model) reads a file in the browser and
lets the admin pick which picture is the front and which the back. Nothing is uploaded until they choose; then the chosen
pictures (re-drawn as trimmed PNGs, or a ready PNG/JPEG/WebP kept as it is) go through the ordinary
`POST /switch-models/:id/images/:side`, so **the server has no new code and no new attack surface**: it still takes only
PNG/JPEG/WebP of at most 8 MiB, judged on their own bytes. All reading and drawing is `apps/web/src/lib/stencils/`;
the dialog is `components/stencil-importer.tsx`.

What it reads (what a file is comes from its own bytes, never its name):

| File | How |
|---|---|
| `.zip` | A vendor download as it comes. Inside, the newest Visio format is read (`.vssx`/`.vsdx`, else `.vss`/`.vsd`), and the PowerPoint copy and loose pictures are named as skipped so the same art does not appear three times; with no Visio file the `.ppt`/`.pptx` is read, then loose pictures, then one more level of zips. |
| `.vssx`, `.vsdx` | A zip of XML (`vsdx.ts`). `masters.xml` gives each master's name and prompt text; the master's ForeignData points through its relationships at the picture in `visio/media`. Media nothing points at is listed unnamed. |
| `.vss`, `.vsd` | Binary Visio 2003 and the older v6 layout (`visio-binary.ts`, below). Names come from the master's own shape text. |
| `.ppt` | `Pictures` stream of an OLE file: Office Art blips, metafiles inflated (`ppt.ts`). No names. |
| `.pptx` (and `.docx`, `.xlsx`) | Files under `media/`. |
| PNG, JPEG, WebP, GIF, BMP, SVG, EMF | One picture, named after the file. SVG is drawn through an `<img>`, never inserted into the page. |

Not drawn yet: WMF, PICT and TIFF pictures (found and listed, then refused with a reason; a pack almost always has the same art
as an EMF or Visio master too), and Visio shapes that are drawn geometry and not a picture (said so when a file has no pictures).

**Binary Visio** is a compound file with one `VisioDocument` stream. A pointer (type, offset, length, format) at byte `0x24`
leads to a table of pointers; each names a block that is LZ-compressed when bit 1 of its format is set (`lzss.ts`: a 4096-byte
ring, flag bytes, copies of 3 to 18 bytes), and most blocks list more pointers at an offset held in their own second word
(count at that offset + 4, then 18-byte records). A stencil's masters hang off the block of type `0x1d`, one `0x1e` pointer per
master; a master's art is an EMF kept whole in a leaf block and is found by its own header, its description is in a `0x0a`
block and "ID: description" in its `0x47` shape block (UTF-16, or single-byte with a leading length character in the v6 layout).
This was worked out from the files themselves and **checked against libvisio on eleven Cisco stencils (v6 and v11): every
picture libvisio writes out is found, byte for byte** (zero missing; the Nexus 2000 yields five more that libvisio does not
print). To re-check a new kind of file, run libvisio's `vss2xhtml` (Debian `libvisio-tools`), hash the `data:image/emf` payloads
and compare with `readVisioBinary`; no vendor file is in the repo.

**EMF drawing** (`emf.ts`) is our own: browsers cannot draw EMF and the one JavaScript renderer tried (rtf.js) failed on every
vendor file. It draws the records these files use (paths, polygons, Beziers, pens, brushes, pattern brushes, transforms, clipping,
bitmaps, text) onto a canvas, and ignores EMF+ comments (the files are "dual": the plain records are complete). Unknown records are
counted and skipped, never fatal. Compared with Inkscape on 133 pictures from six stencils it matches, and is better on bitmaps
(LEDs, screw heads and brushed metal that Inkscape leaves out).

Limits and safety: a file over 512 MiB, a zip entry that inflates past what its own header says (or 512 MiB), more than 20000
zip entries, and a Visio file that inflates past 3 GiB are refused with a message; nothing in a file is executed or inserted
into the page. Reading is quick (a 68 MB vendor zip with 162 pictures: under 2 s, under 300 MB of memory). The vendor's artwork is
theirs: this copies pictures only from files the admin chose, into this dashboard's own storage.

### Add-on modules (migration 0072)

Some switches take a plug-in network module with extra, usually faster, ports (a Catalyst 3750-X's C3KX-NM-10G, a 3850's
C3850-NM-4-10G). A module is **a second kind of switch model**: `switch_models.kind` is `switch` (the default, matched to devices
by its model text) or `module` (never matched, no match strings, cannot hold modules itself; the kind is fixed at creation).
A module has its own picture and port boxes, made with the same editor, Auto and importer (the importer's "This is an add-on
module" box, or "New add-on module" on the Device profiles page), and its ports are named as the switch names them for the slot
(`Te1/1/1` ..., with `Gi1/1/1` as an alias when the same cage has another name in another mode).

A switch model lists the modules placed on it in `switch_models.modules` (`[{ id, moduleId, x, y, w, h }]`, fractions of the
host's port-side picture, at most 8, `id` a stable key such as `m1`). The host's page has an **Add-on modules** section
(`components/module-placement-editor.tsx`, saved on its own "Save modules" button, `PATCH /switch-models/:id { modules }`): pick a
module, "Add to <model>", drag it onto the bay (or select it, arrow keys, + and -; or type percentages). The box keeps the module
picture's proportions, so only the width is set (`lib/faceplates/module-ops.ts`, tested). The service refuses a placement that is
not a module, a module that holds modules, and deleting a module that is still placed (409, naming the models).

How it draws (`layoutFromSwitchModel(host, allModels)` in `custom.ts`, tested in `custom.test.ts`): the module's picture becomes an
`overlay` in the host's layout units and each module port a layout port with `group` = the placement id and the key
`<placement>/<name>`, scaled into the box. **A module shows only while the switch reports one of its ports** (`SwitchFaceplate`:
an overlay and its ports are drawn when some port of the group has a device row), so no per-switch setting says who has the module,
a switch without it is drawn as before (no empty cages), and one bay can hold alternatives (a 1G and a 10G module), each switch
showing the one it really has. A name claimed twice goes to the first claimant (the host's own ports, then the modules in the order
placed); the editor lists such clashes in amber. Limits: a module's port names are absolute, so it describes the module in the
*first* switch of a stack (other members' ports are listed under the picture, as for any model), and a module is not read from
`show inventory`: it appears because its ports do. A model from an API that has not been upgraded yet (no `kind` or `modules`) is
a switch with none (`normaliseModel`).

### The editor (`components/port-layout-editor.tsx`, `port-autolayout-panel.tsx`)

Drag a box to move it, the corner square to resize (all selected boxes change together), drag on empty space to select several,
arrow keys nudge (Shift = 10 px of the picture), Delete, Ctrl+Z / Ctrl+Y. Undo history and the unsaved boxes live in the page;
nothing is saved until "Save layout". What it does to boxes is pure and tested: `lib/faceplates/editor-ops.ts`.

**Auto** proposes boxes as dashed ghosts on the picture and adds them only when asked, so the admin always has the last word:

1. *Find sockets* (`lib/faceplates/detect.ts`): sockets are dark, solid, roughly square blobs darker than their surroundings.
   Several dark masks are tried (darker than a window around each pixel, at three window sizes, and a fixed darkness cut-off
   for big dark cages on a light faceplate, plain and stricter so thin light gaps between cages stay open) and the one whose
   boxes cover the most of the picture wins (by area, not count: vent holes and printed arrows are many and tiny). The picture
   is shrunk by averaging, so a thin light line between two cages survives. Boxes are grouped by size (RJ45, SFP cages, ...
   come out as separate groups, the group covering the most area first; a group much smaller than the main one is offered
   but off, it is probably LEDs or vents). "Select area" restricts it to a box drawn round the ports, which helps on busy photos.
   Checked on Cisco's drawn Nexus 3000 front (N3K-C3064PQ): all 48 SFP+ cages found and numbered 1 above 2; the four
   mid-grey QSFP cages at the right were not (draw them, or use an even grid of 2 x 2 over them).
2. *Even grid*: rows x columns across the area, with an optional wider gap after every N columns, for a picture the detector
   cannot read.
3. *Rename selected*: numbers boxes that are already placed, in order.

Naming: a pattern with `{n}` (`Gi1/0/{n}`) and a first number; the order is "down each column, then across" (Cisco: 1 above 2,
which is the default) or "along each row". Detection is a heuristic on pixels: a plain photo of a light faceplate with dark
sockets works well, a black faceplate or a glare does not, and that is what the area box, the grid and dragging are for.

## Built-in layouts (fallback)

Three Cisco models have a rough drawn layout in code (`apps/web/src/lib/faceplates/layouts.ts`, millimetres on a 1U panel,
`calibrated: false`, no photo). They exist so a model looks like something before an admin sets it up; they are approximate.

To add one in code instead (rarely needed now):

1. Put the photo in `apps/web/public/switch-images/<id>.webp` (front/port side, square on, cropped to the chassis edge to
   edge so its width and height match the panel). Keep it under about 300 KB.
2. Add a `FaceplateLayout` to `FACEPLATE_LAYOUTS` and a match in `faceplateForModel`. Positions are millimetres on the
   panel from the top left (a 1U 19" switch is 482.6 x 44.45); the photo is scaled to the same width and height, so
   calibrating is only changing numbers. Set `image` and, once the boxes sit on the real ports, `calibrated: true`
   (until then the page says "Port positions on this model are approximate").
3. Slot keys: main-board ports are "1".."N", uplink-module cages "m1".."m4". `ciscoSlotFor` maps an interface name to a
   key; extend it for a new naming scheme. A name with no slot (port channels, VLAN interfaces, the rear management
   port, a second stack member) is listed under the picture as "Other interfaces" so nothing disappears.
4. The layout test checks unique keys, nothing outside the panel, nothing overlapping. Look at it in a browser too.

A model with a layout but no photo is drawn as a plain chassis, so layouts can be added before pictures.

## Rules

- One uplink cage can be in the desired config under two names (`Gi1/1/1` and `Te1/1/1`, from whichever module was
  fitted before). `faceItems` draws the one the switch has reported on (`operStatus` not null); the other is listed.
- A port's colour is never the only signal: the button's accessible name carries the state in words, the popover says it,
  and there is a legend. The panel scrolls sideways below 760 px (it is a 10:1 picture), and on a phone it is made wide enough that the smallest port button is 24 px square (WCAG 2.2 target size); the list view is the
  accessible alternative on a phone.
- A popover opened by hover closes after a short delay and is kept open while the pointer is on it; a different port only
  takes it over if the pointer rests there (the pointer crosses neighbours on its way to the popover). Enter or a click pins it,
  focus moves into it, Escape closes it and returns focus to the port.

## UniFi device page

`/monitoring/network/devices/<mac>` (MAC lower case; the device name in the Network (UniFi) devices table links to it, and
so do cabinets, search and the home page's problems) uses the same component and the same device profiles: a box is named
for whatever the device calls its port, so a profile matching `US48PRO` with ports named "1" to "52" is all a UniFi switch
needs. The page reads the controller through the existing `/unifi/devices` and `/unifi/clients` routes (the realtime
`network` room while it is open, a 30 s poll otherwise) and the port sheet (`/port-sheets/unifi/<mac>`) for each port's
network and subnet; there is no new API route. The pure mapping is `apps/web/src/lib/unifi-ports.ts` (unit-tested in
`unifi-ports.test.ts`): `unifiSlotFor` places a port by its number, then by its own name, and only on a profile (the Cisco
built-in layouts never place UniFi ports, so a device with no matching profile gets the table); `clientsByPort` takes wired
clients by `sw_mac`/`sw_port`. The popover shows link, network, subnet, PoE (only while power is drawn), media and the
clients on the port. UniFi ports have no desired config here, so nothing on the page changes a port. The picture is chosen
with the "Picture" button (the only place the device's own choice is made; a cabinet item can still pick its own, see [cabinets.md](cabinets.md)). A device with no port
table (an access point) shows its profile's pictures instead.

## Tests

`lib/stencils/*.test.ts` (the zip, OLE and LZ readers, binary Visio and Visio/PowerPoint packages on small synthetic files built in
`test-builders.ts`, what a file is, the EMF reader and renderer against a recording canvas, front/back choices),
`switch-model-import.spec.ts` in `tests/e2e`,
`lib/faceplates/*.test.ts` (layouts, matching, detection on synthetic pictures, editor operations, module placement),
`apps/api/test/switch-models.test.ts` (image sizes, schemas), `switch-models.integration.test.ts` (CockroachDB and YugabyteDB,
including the module rules), `lib/unifi-ports.test.ts`, `cisco-switch-view.spec.ts`, `switch-models.spec.ts`, `switch-model-modules.spec.ts` and
`unifi-device.spec.ts` (with an axe check of both views) in `tests/e2e`
(fake API through `page.route`; the live stack only supplies the pages and the signed-in user).
