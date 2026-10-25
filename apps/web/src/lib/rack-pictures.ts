import type { RackItemView, SwitchModel } from "@church/shared";
import { matchSwitchModel, resolveSwitchView, switchModelImageUrl } from "@/lib/faceplates/custom";

export type RackSide = "front" | "rear";

export interface RackPicture {
  url: string;
  width: number;
  height: number;
  modelName: string;
}

/**
 * Which switch model supplies an item's pictures: the one picked for the item, else (a Cisco switch) the one its own page
 * resolves to, else a model whose match text appears in the device's model. An admin who turned the picture off on the
 * switch page gets none from there, but a model picked on the item itself always wins.
 */
export function pictureModelFor(item: Pick<RackItemView, "modelId" | "sourceKind" | "live">, models: readonly SwitchModel[]): SwitchModel | null {
  if (item.modelId) {
    const picked = models.find((m) => m.id === item.modelId && m.kind !== "module");
    if (picked) return picked;
  }
  if (item.sourceKind === "cisco") {
    return resolveSwitchView(models, { model: item.live.model, switchModelId: item.live.switchModelId, switchViewOff: item.live.switchViewOff }).model;
  }
  if (item.sourceKind === "custom") return null;
  return matchSwitchModel(models, item.live.model);
}

/** The picture for one side of an item, or null when its model has none for that side (the elevation then draws one). */
export function rackItemPicture(item: Pick<RackItemView, "modelId" | "sourceKind" | "live">, models: readonly SwitchModel[], side: RackSide): RackPicture | null {
  return modelPicture(pictureModelFor(item, models), side);
}

export function modelPicture(model: SwitchModel | null, side: RackSide): RackPicture | null {
  if (!model) return null;
  const which = side === "front" ? "front" : "back";
  const imageId = which === "front" ? model.frontImageId : model.backImageId;
  const width = which === "front" ? model.frontWidth : model.backWidth;
  const height = which === "front" ? model.frontHeight : model.backHeight;
  if (!imageId || !width || !height) return null;
  return { url: switchModelImageUrl(model.id, which, imageId), width, height, modelName: model.name };
}
