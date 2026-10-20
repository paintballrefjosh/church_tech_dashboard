import type { SetSwitchViewInput, SwitchModel } from "@church/shared";
import { faceplateForModel, type FaceplateLayout } from "./layouts";

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
  if (sw.switchModelId && models.some((m) => m.id === sw.switchModelId)) return `model:${sw.switchModelId}`;
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
        ? `Switch view: the built-in drawing for ${text} (approximate). No switch model matches "${text}".`
        : `No switch model matches "${text}", so this switch's ports are listed only.`;
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
  const picked = device.switchModelId ? models.find((m) => m.id === device.switchModelId) : undefined;
  if (picked) return { how: "chosen", model: picked, matched: null, layout: layoutFromSwitchModel(picked) };
  const hit = matchSwitchModelDetail(models, device.model);
  if (hit) return { how: "matched", model: hit.model, matched: hit.matched, layout: layoutFromSwitchModel(hit.model) ?? faceplateForModel(device.model) };
  return { how: "none", model: null, matched: null, layout: faceplateForModel(device.model) };
}

/** Width of a custom layout in its own units: the picture's height follows from its proportions. */
export const CUSTOM_LAYOUT_WIDTH = 1000;

/**
 * A model as a layout the faceplate can draw, or null while it cannot be drawn yet (no picture on the port side, or no
 * ports on it). A model with no ports is still editable; it just has no switch view to show.
 */
export function layoutFromSwitchModel(m: SwitchModel): FaceplateLayout | null {
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
    ports,
    otherImage: otherId && ow && oh ? { side: otherSide, url: switchModelImageUrl(m.id, otherSide, otherId), width: ow, height: oh } : undefined,
  };
}
