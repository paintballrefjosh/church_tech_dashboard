import { z } from "zod";

/**
 * Cabinets (racks) and what sits in them. A cabinet is a name and a height in U; an item is a place in it (the lowest U it
 * occupies and how many it spans) for either a device the dashboard already knows (a Cisco switch, an infrastructure host,
 * a UniFi device) or a custom thing (patch panel, PDU, shelf, blanking panel ...). Linked items keep only a pointer, so the
 * name, address and status shown are the device's own; the stored label/hostname/ip are what is shown when the device
 * cannot be read (a UniFi controller that is down, a device since deleted).
 */

export const RACK_SOURCE_KINDS = ["cisco", "infra", "unifi", "custom"] as const;
export type RackSourceKind = (typeof RACK_SOURCE_KINDS)[number];

/** How an item with no picture is drawn. */
export const RACK_ITEM_STYLES = ["switch", "server", "access_point", "gateway", "patch_panel", "pdu", "ups", "shelf", "blank", "other"] as const;
export type RackItemStyle = (typeof RACK_ITEM_STYLES)[number];

export const RACK_ITEM_STYLE_LABELS: Record<RackItemStyle, string> = {
  switch: "Switch",
  server: "Server",
  access_point: "Access point",
  gateway: "Gateway / firewall",
  patch_panel: "Patch panel",
  pdu: "Power strip (PDU)",
  ups: "UPS",
  shelf: "Shelf",
  blank: "Blanking panel",
  other: "Other",
};

/** The style a linked source starts with. */
export function defaultRackStyle(kind: RackSourceKind): RackItemStyle {
  switch (kind) {
    case "cisco":
      return "switch";
    case "infra":
      return "server";
    case "unifi":
      return "switch";
    default:
      return "other";
  }
}

export const MAX_RACK_UNITS = 60;
export const DEFAULT_RACK_UNITS = 42;
export const MAX_RACK_ITEMS = 120;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "no control characters");

export const rackSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  location: z.string(),
  units: z.number().int(),
  notes: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Rack = z.infer<typeof rackSchema>;

export const createRackSchema = z.object({
  name: text(80).pipe(z.string().min(1, "a name is required")),
  location: text(120).default(""),
  units: z.number().int().min(1).max(MAX_RACK_UNITS).default(DEFAULT_RACK_UNITS),
  notes: z.string().trim().max(2000).default(""),
});
export type CreateRackInput = z.infer<typeof createRackSchema>;

export const updateRackSchema = createRackSchema.partial();
export type UpdateRackInput = z.infer<typeof updateRackSchema>;

/** An item as stored. `startU` is the lowest U it occupies (U1 is the bottom, as on the rack's own rails). */
export const rackItemSchema = z.object({
  id: z.string().uuid(),
  rackId: z.string().uuid(),
  sourceKind: z.enum(RACK_SOURCE_KINDS),
  /** Cisco switch id or infra target id (uuid); a UniFi device's MAC; null for a custom item. */
  sourceId: z.string().nullable(),
  label: z.string(),
  hostname: z.string().nullable(),
  ip: z.string().nullable(),
  style: z.enum(RACK_ITEM_STYLES),
  startU: z.number().int(),
  heightU: z.number().int(),
  /** A switch model whose front/back pictures are drawn for this item (null = whatever the device resolves to). */
  modelId: z.string().uuid().nullable(),
  notes: z.string(),
});
export type RackItemRow = z.infer<typeof rackItemSchema>;

/** What the item says about itself right now, read from the device it points at (custom items just echo themselves). */
export const rackItemLiveSchema = z.object({
  name: z.string(),
  hostname: z.string().nullable(),
  ip: z.string().nullable(),
  /** The device's own model text (a Cisco PID, a UniFi model code), used to find a picture. */
  model: z.string().nullable(),
  status: z.enum(["up", "down", "unknown"]),
  /** The device was deleted (or is not in the UniFi controller's list): the item keeps its place, with what was last known. */
  missing: z.boolean(),
  /** The page that shows the device, when there is one. */
  href: z.string().nullable(),
  /** Cisco only: the picture choice made on the switch's own page. */
  switchModelId: z.string().uuid().nullable(),
  switchViewOff: z.boolean(),
});
export type RackItemLive = z.infer<typeof rackItemLiveSchema>;

export const rackItemViewSchema = rackItemSchema.extend({ live: rackItemLiveSchema });
export type RackItemView = z.infer<typeof rackItemViewSchema>;

export const rackDetailSchema = rackSchema.extend({ items: z.array(rackItemViewSchema) });
export type RackDetail = z.infer<typeof rackDetailSchema>;

export const rackListEntrySchema = rackSchema.extend({ itemCount: z.number().int(), usedUnits: z.number().int() });
export type RackListEntry = z.infer<typeof rackListEntrySchema>;

const itemShape = {
  label: text(120).optional(),
  hostname: text(120).nullable().optional(),
  ip: text(64).nullable().optional(),
  style: z.enum(RACK_ITEM_STYLES).optional(),
  startU: z.number().int().min(1).max(MAX_RACK_UNITS),
  heightU: z.number().int().min(1).max(MAX_RACK_UNITS),
  modelId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).optional(),
};

export const createRackItemSchema = z
  .object({
    sourceKind: z.enum(RACK_SOURCE_KINDS),
    sourceId: z.string().trim().min(1).max(64).nullable().optional(),
    ...itemShape,
  })
  .superRefine((v, ctx) => {
    if (v.sourceKind === "custom") {
      if (v.sourceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "a custom item has no source" });
      if (!v.label) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["label"], message: "a name is required" });
    } else if (!v.sourceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "pick the device" });
    }
  });
export type CreateRackItemInput = z.infer<typeof createRackItemSchema>;

/** What an item points at never changes after placing (remove the item and place another). */
export const updateRackItemSchema = z.object({
  label: itemShape.label,
  hostname: itemShape.hostname,
  ip: itemShape.ip,
  style: itemShape.style,
  startU: itemShape.startU.optional(),
  heightU: itemShape.heightU.optional(),
  modelId: itemShape.modelId,
  notes: itemShape.notes,
});
export type UpdateRackItemInput = z.infer<typeof updateRackItemSchema>;

/** A device the dashboard knows that could be placed in a cabinet. */
export const rackCandidateSchema = z.object({
  kind: z.enum(["cisco", "infra", "unifi"]),
  id: z.string(),
  name: z.string(),
  hostname: z.string().nullable(),
  ip: z.string().nullable(),
  model: z.string().nullable(),
  /** How it would be drawn with no picture (a UniFi access point and a UniFi switch look different). */
  style: z.enum(RACK_ITEM_STYLES),
  /** Where it is placed already (a device is normally in one cabinet only), if anywhere. */
  placedIn: z.object({ rackId: z.string().uuid(), rackName: z.string() }).nullable(),
});
export type RackCandidate = z.infer<typeof rackCandidateSchema>;
