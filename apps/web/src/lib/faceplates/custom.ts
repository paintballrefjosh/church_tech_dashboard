import type { SetSwitchViewInput, SwitchModel } from "@church/shared";
import { faceplateForModel, type FaceplatePortSpec, type FaceplateLayout, type FaceplateOverlay } from "./layouts";

/** Where a model's picture is served from. `?v=` is the attachment id, so a replaced picture is a new URL (the API caches for a day). */
export function switchModelImageUrl(modelId: string, side: "front" | "back", imageId: string): string {
  return `/api/switch-models/${modelId}/images/${side}?v=${imageId}`;
}

/**
 * The admin's model for a device model string ("WS-C3850-48F-E"), or null. A model matches when the text contains one of
 * its strings (any case); when several match, the one with the longest matching string wins, then the first by name.
 */
export function matchSwitchModel(models: readonly SwitchModel[], deviceModel: string | null | undefined): SwitchModel | null {
  return matchSwitchModelDetail(models, deviceModel)?.model ?? null;
}

/** Like `matchSwitchModel`, and also says which of the model's strings caught the text (as the admin typed it). */
export function matchSwitchModelDetail(
  models: readonly SwitchModel[],
  deviceModel: string | null | undefined,
): { model: SwitchModel; matched: string } | null {
  const text = (deviceModel ?? "").trim().toUpperCase();
  if (!text) return null;
  let best: { model: SwitchModel; matched: string; len: number } | null = null;
  for (const m of models) {
    if (m.kind === "module") continue; // an add-on module is placed on a switch, never matched to one
    for (const raw of m.match) {
      const pattern = raw.trim().toUpperCase();
      if (pattern.length < 2 || !text.includes(pattern)) continue;
      if (!best || pattern.length > best.len || (pattern.length === best.len && m.name.localeCompare(best.model.name) < 0)) {
        best = { model: m, matched: raw.trim(), len: pattern.length };
      }
    }
  }
  return best ? { model: best.model, matched: best.matched } : null;
}

/** What a switch's picture is decided by: an admin turned it off, an admin picked a model, the model text matched one, or nothing did. */
export interface SwitchView {
  how: "off" | "chosen" | "matched" | "none";
  /** The model in play (picked or matched), whether or not it can be drawn yet. */
  model: SwitchModel | null;
  /** The match string that caught the device's model text (only when `how` is "matched"). */
  matched: string | null;
  /** What is drawn: the model's layout, else (not for a pick) the built-in drawing for the device model, else null. */
  layout: FaceplateLayout | null;
}

/** What the picker shows for a switch: its saved choice ("auto", "off" or "model:<id>"), read from the switch row. */
export function currentChoice(models: readonly SwitchModel[], sw: { switchModelId?: string | null; switchViewOff?: boolean }): string {
  if (sw.switchViewOff) return "off";
  if (sw.switchModelId && models.some((m) => m.id === sw.switchModelId && m.kind !== "module")) return `model:${sw.switchModelId}`;
  return "auto";
}

/** A picker value ("auto", "off" or "model:<id>") as what the API takes and what `resolveSwitchView` reads. */
export function choiceToInput(value: string): SetSwitchViewInput {
  if (value === "off") return { mode: "off" };
  if (value.startsWith("model:")) return { mode: "model", modelId: value.slice("model:".length) };
  return { mode: "auto" };
}
export function choiceToDevice(value: string): { switchModelId: string | null; switchViewOff: boolean } {
  const input = choiceToInput(value);
  return { switchModelId: input.mode === "model" ? (input.modelId ?? null) : null, switchViewOff: input.mode === "off" };
}

/** One sentence that says where a switch's picture came from, and why. */
export function switchViewSentence(view: SwitchView, deviceModel: string | null): string {
  const text = deviceModel ?? "";
  const built = view.layout !== null && view.layout.source !== "custom"; // a built-in layout leaves `source` unset
  switch (view.how) {
    case "off":
      return "Switch view: turned off for this switch, so its ports are listed only.";
    case "chosen":
      return view.layout
        ? `Switch view: ${view.model!.name}, chosen for this switch.`
        : `You chose ${view.model!.name} for this switch, but it has no port layout yet, so its ports are listed only.`;
    case "matched":
      if (view.layout && !built) return `Switch view: ${view.model!.name}, matched on "${view.matched}" in the model text ${text}.`;
      return built
        ? `${view.model!.name} matches "${view.matched}" but has no port layout yet, so the built-in drawing for ${text} is shown.`
        : `${view.model!.name} matches "${view.matched}" but has no port layout yet, so this switch's ports are listed only.`;
    default:
      if (!text) return "This switch has not reported its model yet, so its ports are listed only.";
      return built
        ? `Switch view: the built-in drawing for ${text} (approximate). No device profile matches "${text}".`
        : `No device profile matches "${text}", so this switch's ports are listed only.`;
  }
}

/**
 * Decides which picture a switch gets. An admin's choice for this switch comes first ("off" lists the ports only; a pick
 * of a model that no longer exists counts as no choice), then the model text against the models' match strings, then
 * the built-in drawings for a few Cisco models. A model picked by hand that cannot be drawn yet (no picture on its port
 * side, or no ports) draws nothing rather than quietly drawing something else.
 */
export function resolveSwitchView(
  models: readonly SwitchModel[],
  device: { model: string | null | undefined; switchModelId?: string | null; switchViewOff?: boolean },
): SwitchView {
  if (device.switchViewOff) return { how: "off", model: null, matched: null, layout: null };
  const picked = device.switchModelId ? models.find((m) => m.id === device.switchModelId && m.kind !== "module") : undefined;
  if (picked) return { how: "chosen", model: picked, matched: null, layout: layoutFromSwitchModel(picked, models) };
  const hit = matchSwitchModelDetail(models, device.model);
  if (hit) return { how: "matched", model: hit.model, matched: hit.matched, layout: layoutFromSwitchModel(hit.model, models) ?? faceplateForModel(device.model) };
  return { how: "none", model: null, matched: null, layout: faceplateForModel(device.model) };
}

/** Width of a custom layout in its own units: the picture's height follows from its proportions. */
export const CUSTOM_LAYOUT_WIDTH = 1000;

/** The key of a module's port on the host's layout: the placement id keeps two copies of one module apart. */
export function modulePortKey(placementId: string, portName: string): string {
  return `${placementId}/${portName}`;
}

/** The name a person knows a layout port by ("Te1/1/1"), without the placement prefix a module port's key carries. */
export function portLabelOfKey(key: string): string {
  const at = key.indexOf("/");
  return at < 0 ? key : key.slice(at + 1);
}

/**
 * The add-on modules placed on a host, as pictures and ports in the host's layout units. A module's port boxes are
 * fractions of the module's own picture, so they are scaled into the box the module was placed in. A module that cannot be
 * drawn (deleted, no picture, no ports) is left out. On a name clash the host's own port, or the earlier module, keeps the
 * name; the later port is still drawn but a device port can only land on the first.
 */
function placeModules(
  host: SwitchModel,
  all: readonly SwitchModel[],
  width: number,
  height: number,
  names: Record<string, string>,
): { ports: FaceplatePortSpec[]; overlays: FaceplateOverlay[] } {
  const ports: FaceplatePortSpec[] = [];
  const overlays: FaceplateOverlay[] = [];
  for (const pl of host.modules) {
    const mod = all.find((x) => x.id === pl.moduleId && x.kind === "module");
    if (!mod) continue;
    const imageId = mod.portSide === "front" ? mod.frontImageId : mod.backImageId;
    const w = mod.portSide === "front" ? mod.frontWidth : mod.backWidth;
    const h = mod.portSide === "front" ? mod.frontHeight : mod.backHeight;
    if (!imageId || !w || !h || mod.ports.length === 0) continue;
    overlays.push({
      id: pl.id,
      label: mod.name,
      url: switchModelImageUrl(mod.id, mod.portSide, imageId),
      x: pl.x * width,
      y: pl.y * height,
      w: pl.w * width,
      h: pl.h * height,
    });
    for (const p of mod.ports) {
      const key = modulePortKey(pl.id, p.name);
      for (const n of [p.name, ...p.aliases]) if (!(n.toLowerCase() in names)) names[n.toLowerCase()] = key;
      ports.push({
        key,
        group: pl.id,
        kind: p.kind,
        x: (pl.x + p.x * pl.w) * width,
        y: (pl.y + p.y * pl.h) * height,
        w: p.w * pl.w * width,
        h: p.h * pl.h * height,
      });
    }
  }
  return { ports, overlays };
}

/** An add-on module that a switch really has, placed on its host's port-side picture (all four numbers are fractions of that picture). */
export interface InstalledModule {
  id: string;
  label: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The module's port boxes, already scaled into the host's picture (fractions of it). */
  ports: { name: string; x: number; y: number; w: number; h: number }[];
}

/**
 * The modules placed on `host` that the device has: a placement counts while the device reports one of the module's
 * ports (by name or alias, any case), the same rule the switch page uses to draw them. A module that cannot be drawn
 * (deleted, no picture) is left out.
 */
export function installedModules(host: SwitchModel, all: readonly SwitchModel[], portNames: readonly string[]): InstalledModule[] {
  if (host.modules.length === 0 || portNames.length === 0) return [];
  const have = new Set(portNames.map((n) => n.toLowerCase()));
  const out: InstalledModule[] = [];
  for (const pl of host.modules) {
    const mod = all.find((x) => x.id === pl.moduleId && x.kind === "module");
    if (!mod) continue;
    const imageId = mod.portSide === "front" ? mod.frontImageId : mod.backImageId;
    if (!imageId) continue;
    if (!mod.ports.some((p) => [p.name, ...p.aliases].some((n) => have.has(n.toLowerCase())))) continue;
    out.push({ id: pl.id, label: mod.name, url: switchModelImageUrl(mod.id, mod.portSide, imageId),
      x: pl.x,
      y: pl.y,
      w: pl.w,
      h: pl.h,
      ports: mod.ports.map((p) => ({ name: p.name, x: pl.x + p.x * pl.w, y: pl.y + p.y * pl.h, w: p.w * pl.w, h: p.h * pl.h })),
    });
  }
  return out;
}

/**
 * A model as a layout the faceplate can draw, or null while it cannot be drawn yet (no picture on the port side, or no
 * ports on it). A model with no ports is still editable; it just has no switch view to show. `all` is every model, for
 * the add-on modules placed on this one.
 */
export function layoutFromSwitchModel(m: SwitchModel, all: readonly SwitchModel[] = []): FaceplateLayout | null {
  const side = m.portSide;
  const imageId = side === "front" ? m.frontImageId : m.backImageId;
  const w = side === "front" ? m.frontWidth : m.backWidth;
  const h = side === "front" ? m.frontHeight : m.backHeight;
  if (!imageId || !w || !h || m.ports.length === 0) return null;

  const width = CUSTOM_LAYOUT_WIDTH;
  const height = (CUSTOM_LAYOUT_WIDTH * h) / w;
  const names: Record<string, string> = {};
  const ports = m.ports.map((p) => {
    for (const n of [p.name, ...p.aliases]) names[n.toLowerCase()] = p.name;
    return { key: p.name, kind: p.kind, x: p.x * width, y: p.y * height, w: p.w * width, h: p.h * height };
  });
  const placed = placeModules(m, all, width, height, names);

  const otherSide = side === "front" ? "back" : "front";
  const otherId = otherSide === "front" ? m.frontImageId : m.backImageId;
  const ow = otherSide === "front" ? m.frontWidth : m.backWidth;
  const oh = otherSide === "front" ? m.frontHeight : m.backHeight;

  return {
    id: `model:${m.id}`,
    title: m.name,
    family: "catalyst",
    source: "custom",
    modelId: m.id,
    names,
    width,
    height,
    image: switchModelImageUrl(m.id, side, imageId),
    calibrated: true,
    ports: [...ports, ...placed.ports],
    overlays: placed.overlays.length > 0 ? placed.overlays : undefined,
    otherImage: otherId && ow && oh ? { side: otherSide, url: switchModelImageUrl(m.id, otherSide, otherId), width: ow, height: oh } : undefined,
  };
}
