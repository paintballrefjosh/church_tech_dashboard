/**
 * The faceplate library: for each switch model we can draw, the size of its front (port side) and where every port
 * sits on it. The web draws a photo of the switch (`image`) and lays a button over each port; with no photo it draws
 * a plain chassis instead, so a model can be added before its picture is.
 *
 * Positions are in millimetres on the front panel (a 19" 1U switch is 482.6 x 44.45), measured from the top left.
 * Photos are scaled to the same width and height, so recalibrating a model is changing numbers here, nothing else.
 *
 * `calibrated` is false until the numbers have been checked against the photo they are drawn over.
 */

export type FaceKind = "rj45" | "sfp" | "qsfp" | "other";

export interface FaceplatePortSpec {
  /** Slot key a device's port maps to (see `ciscoSlotFor`): "1".."48" for the main board, "m1".."m4" for a module cage. */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: FaceKind;
  /** custom only: the placement of the add-on module this port belongs to; the port shows only while that module does. */
  group?: string;
}

/** An add-on module's picture on a custom layout; drawn only while the device reports one of the ports in its `group`. */
export interface FaceplateOverlay {
  /** The placement id, equal to the `group` of the module's ports. */
  id: string;
  label: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceplateLayout {
  id: string;
  /** Shown on the drawn chassis and as the picture's alt text. */
  title: string;
  /** How a device's own port names map onto `ports[].key`. */
  family: "catalyst" | "nexus";
  width: number;
  height: number;
  /** Public path of the photo, or null when there is none yet. */
  image: string | null;
  calibrated: boolean;
  ports: FaceplatePortSpec[];
  /** "builtin": a layout in this file, slots mapped by `ciscoSlotFor`. "custom": an admin's switch model, slots are port names. */
  source?: "builtin" | "custom";
  /** custom only: the model's id, for the "edit this layout" link. */
  modelId?: string;
  /** custom only: lower-case interface name or alias to the slot key of the port that has it. */
  names?: Record<string, string>;
  /** custom only: add-on modules placed on the picture, in the order they were added. */
  overlays?: FaceplateOverlay[];
  /** custom only: the picture of the other side of the switch (no ports on it), if one was uploaded. */
  otherImage?: { side: "front" | "back"; url: string; width: number; height: number };
}

const RACK_W = 482.6;
const RACK_1U = 44.45;

/** Ports numbered odd-on-top, even-below, left to right (how Catalyst and Nexus number a two-row panel). */
function twoRowPorts(o: {
  first: number;
  count: number;
  kind: FaceKind;
  x0: number;
  y0: number;
  w: number;
  h: number;
  pitchX: number;
  rowGap: number;
  /** A wider gap after every this many columns, as the panel has. */
  groupSize: number;
  groupGap: number;
}): FaceplatePortSpec[] {
  const out: FaceplatePortSpec[] = [];
  for (let i = 0; i < o.count; i++) {
    const col = Math.floor(i / 2);
    const row = i % 2;
    out.push({
      key: String(o.first + i),
      kind: o.kind,
      x: round(o.x0 + col * o.pitchX + Math.floor(col / o.groupSize) * o.groupGap),
      y: round(o.y0 + row * (o.h + o.rowGap)),
      w: o.w,
      h: o.h,
    });
  }
  return out;
}

/** An uplink module's cages, `cols` across, numbered row by row from the top left: keys m1, m2 ... */
function moduleCages(o: { count: number; cols: number; x0: number; y0: number; w: number; h: number; gapX: number; gapY: number }): FaceplatePortSpec[] {
  const out: FaceplatePortSpec[] = [];
  for (let i = 0; i < o.count; i++) {
    out.push({
      key: `m${i + 1}`,
      kind: "sfp",
      x: round(o.x0 + (i % o.cols) * (o.w + o.gapX)),
      y: round(o.y0 + Math.floor(i / o.cols) * (o.h + o.gapY)),
      w: o.w,
      h: o.h,
    });
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const ROW_GAP = 3;
const RJ_H = 11;
const RJ_Y0 = round((RACK_1U - (2 * RJ_H + ROW_GAP)) / 2);

export const FACEPLATE_LAYOUTS: readonly FaceplateLayout[] = [
  {
    id: "cisco-c3750x-48",
    title: "Cisco Catalyst 3750-X 48",
    family: "catalyst",
    width: RACK_W,
    height: RACK_1U,
    image: null,
    calibrated: false,
    ports: [
      ...twoRowPorts({ first: 1, count: 48, kind: "rj45", x0: 62, y0: RJ_Y0, w: 12, h: RJ_H, pitchX: 12.8, rowGap: ROW_GAP, groupSize: 6, groupGap: 3.4 }),
      ...moduleCages({ count: 4, cols: 2, x0: 398, y0: RJ_Y0, w: 14, h: RJ_H, gapX: 3, gapY: ROW_GAP }),
    ],
  },
  {
    id: "cisco-c3850-48",
    title: "Cisco Catalyst 3850 48",
    family: "catalyst",
    width: RACK_W,
    height: RACK_1U,
    image: null,
    calibrated: false,
    ports: [
      ...twoRowPorts({ first: 1, count: 48, kind: "rj45", x0: 48, y0: RJ_Y0, w: 12, h: RJ_H, pitchX: 12.8, rowGap: ROW_GAP, groupSize: 6, groupGap: 3.4 }),
      ...moduleCages({ count: 4, cols: 2, x0: 384, y0: RJ_Y0, w: 14, h: RJ_H, gapX: 3, gapY: ROW_GAP }),
    ],
  },
  {
    id: "cisco-n3k-c3064pq",
    title: "Cisco Nexus 3064PQ",
    family: "nexus",
    width: RACK_W,
    height: RACK_1U,
    image: null,
    calibrated: false,
    ports: [
      ...twoRowPorts({ first: 1, count: 48, kind: "sfp", x0: 20, y0: RJ_Y0, w: 12.5, h: 9, pitchX: 14.2, rowGap: 5, groupSize: 12, groupGap: 4 }),
      ...twoRowPorts({ first: 49, count: 4, kind: "qsfp", x0: 392, y0: RJ_Y0, w: 20, h: 9, pitchX: 23, rowGap: 5, groupSize: 99, groupGap: 0 }),
    ],
  },
];

/** The layout for a device model string as the device reports it ("WS-C3850-48F-E"), or null when we have none. */
export function faceplateForModel(model: string | null | undefined): FaceplateLayout | null {
  if (!model) return null;
  const m = model.toUpperCase().replace(/\s+/g, "");
  if (/C3850-48/.test(m)) return FACEPLATE_LAYOUTS.find((l) => l.id === "cisco-c3850-48") ?? null;
  if (/C3750X-48/.test(m)) return FACEPLATE_LAYOUTS.find((l) => l.id === "cisco-c3750x-48") ?? null;
  if (/N3K-C3064PQ|C3064PQ/.test(m)) return FACEPLATE_LAYOUTS.find((l) => l.id === "cisco-n3k-c3064pq") ?? null;
  return null;
}

/**
 * Which slot on the faceplate an interface name belongs to, or null when it has no place on the front (a port channel,
 * a VLAN interface, the management port, a breakout lane, a stack member other than the first).
 *
 * Catalyst: `Gi1/0/7` is main-board port 7, `Gi1/1/2` and `Te1/1/2` are cage 2 of the uplink module (the same cage
 * under two names, depending on which module was last fitted). Nexus: `Eth1/7` is port 7.
 */
export function ciscoSlotFor(portId: string, layout: FaceplateLayout): string | null {
  let key: string | null = null;
  if (layout.family === "catalyst") {
    const m = /^(?:Gi|Te|Fa|Tw|Fo|Hu)(\d+)\/(\d+)\/(\d+)$/i.exec(portId);
    if (!m) return null;
    const [, stack, sub, n] = m;
    if (stack !== "1") return null;
    key = sub === "0" ? n! : sub === "1" ? `m${n}` : null;
  } else {
    const m = /^Eth(\d+)\/(\d+)$/i.exec(portId);
    if (!m || m[1] !== "1") return null;
    key = m[2]!;
  }
  return key !== null && layout.ports.some((p) => p.key === key) ? key : null;
}

/** The slot of a layout that a device's interface name belongs to, whichever kind of layout it is. */
export function slotForPort(portId: string, layout: FaceplateLayout): string | null {
  if (layout.source === "custom") return layout.names?.[portId.toLowerCase()] ?? null;
  return ciscoSlotFor(portId, layout);
}
