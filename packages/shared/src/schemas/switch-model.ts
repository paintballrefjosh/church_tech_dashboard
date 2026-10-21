import { z } from "zod";

/**
 * Switch models: what an admin teaches the dashboard about a kind of switch so its ports can be shown on a picture of
 * it (the "switch view"). A model has a front and a back picture, says which of them has the ports on it, and holds
 * one box per port, positioned as a fraction of that picture so the numbers do not depend on how big it is drawn.
 */

export const SWITCH_MODEL_SIDES = ["front", "back"] as const;
export type SwitchModelSide = (typeof SWITCH_MODEL_SIDES)[number];

/** Pictures an admin may upload for a model. */
export const SWITCH_MODEL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const SWITCH_PORT_KINDS = ["rj45", "sfp", "qsfp", "other"] as const;
export type SwitchPortKind = (typeof SWITCH_PORT_KINDS)[number];

export const MAX_SWITCH_MODEL_PORTS = 256;

const fraction = z.number().min(0).max(1);

/** One port on the picture. `name` is the interface as the device calls it ("Gi1/0/7", "Eth1/7", "3"). */
export const switchModelPortSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    /** Other names for the same socket: a cage that is `Gi1/1/1` with one module and `Te1/1/1` with another. */
    aliases: z.array(z.string().trim().min(1).max(32)).max(4).default([]),
    kind: z.enum(SWITCH_PORT_KINDS).default("rj45"),
    /** Left and top edge, width and height, as a fraction of the picture's own width and height. */
    x: fraction,
    y: fraction,
    w: z.number().min(0.002).max(1),
    h: z.number().min(0.002).max(1),
  })
  .refine((p) => p.x + p.w <= 1.0001 && p.y + p.h <= 1.0001, { message: "a port must lie inside the picture" });
export type SwitchModelPort = z.infer<typeof switchModelPortSchema>;

/** Every name (and alias) is one socket's, and a name belongs to one socket only, whatever its case. */
export const switchModelPortsSchema = z
  .array(switchModelPortSchema)
  .max(MAX_SWITCH_MODEL_PORTS)
  .superRefine((ports, ctx) => {
    const seen = new Map<string, number>();
    ports.forEach((p, i) => {
      for (const n of [p.name, ...p.aliases]) {
        const k = n.toLowerCase();
        const at = seen.get(k);
        if (at !== undefined && at !== i) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "name"], message: `"${n}" names more than one port` });
        }
        seen.set(k, i);
      }
    });
  });

/** Strings a device's model is matched against: a model whose text contains one of them (any case) uses this model. */
export const switchModelMatchSchema = z.array(z.string().trim().min(2).max(64)).max(12);

/**
 * A model is a switch (matched to devices by its model text) or an add-on module (a network module such as the
 * C3KX-NM-10G: a picture and port boxes of its own, put on a switch model's picture through `modules`). A module is
 * never matched to a device and cannot hold modules itself. The kind is fixed when the model is created.
 */
export const SWITCH_MODEL_KINDS = ["switch", "module"] as const;
export type SwitchModelKind = (typeof SWITCH_MODEL_KINDS)[number];

export const MAX_SWITCH_MODEL_MODULES = 8;

/**
 * A module placed on a switch model: where its picture sits on the switch's port-side picture (fractions of that
 * picture, like the port boxes). The module's own port boxes are scaled into this box. It is drawn only while the
 * switch reports one of its ports, so one slot can hold several alternatives (a 1G and a 10G module) and each switch
 * shows the one it really has.
 */
export const switchModelModuleSchema = z
  .object({
    /** Stable key for this placement (the same module may be placed twice, e.g. in two bays). */
    id: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/),
    moduleId: z.string().uuid(),
    x: fraction,
    y: fraction,
    w: z.number().min(0.01).max(1),
    h: z.number().min(0.01).max(1),
  })
  .refine((m) => m.x + m.w <= 1.0001 && m.y + m.h <= 1.0001, { message: "a module must lie inside the picture" });
export type SwitchModelModule = z.infer<typeof switchModelModuleSchema>;

export const switchModelModulesSchema = z
  .array(switchModelModuleSchema)
  .max(MAX_SWITCH_MODEL_MODULES)
  .superRefine((mods, ctx) => {
    const seen = new Set<string>();
    mods.forEach((m, i) => {
      if (seen.has(m.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "id"], message: `"${m.id}" is used for two modules` });
      seen.add(m.id);
    });
  });

export const switchModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(SWITCH_MODEL_KINDS),
  match: z.array(z.string()),
  /** Which picture has the ports. The other is shown on request, without port boxes. */
  portSide: z.enum(SWITCH_MODEL_SIDES),
  frontImageId: z.string().uuid().nullable(),
  backImageId: z.string().uuid().nullable(),
  frontWidth: z.number().int().nullable(),
  frontHeight: z.number().int().nullable(),
  backWidth: z.number().int().nullable(),
  backHeight: z.number().int().nullable(),
  ports: z.array(switchModelPortSchema),
  /** Modules placed on this model's port-side picture (always empty for a module). */
  modules: z.array(switchModelModuleSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SwitchModel = z.infer<typeof switchModelSchema>;

export const createSwitchModelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(SWITCH_MODEL_KINDS).default("switch"),
  match: switchModelMatchSchema.default([]),
  portSide: z.enum(SWITCH_MODEL_SIDES).default("front"),
});
export type CreateSwitchModelInput = z.infer<typeof createSwitchModelSchema>;

export const updateSwitchModelSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  match: switchModelMatchSchema.optional(),
  portSide: z.enum(SWITCH_MODEL_SIDES).optional(),
  ports: switchModelPortsSchema.optional(),
  modules: switchModelModulesSchema.optional(),
});
export type UpdateSwitchModelInput = z.infer<typeof updateSwitchModelSchema>;
