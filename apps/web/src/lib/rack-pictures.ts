import type { RackItemView, SwitchModel } from "@church/shared";
import { installedModules, resolveSwitchView, switchModelImageUrl, type InstalledModule } from "./faceplates/custom";

export type RackSide = "front" | "rear";

export interface RackPicture {
  url: string;
  width: number;
  height: number;
  modelName: string;
  /** Add-on modules the device has, to draw over this picture (only on the side that has the ports). */
  modules: InstalledModule[];
}

/**
 * Which device profile supplies an item's pictures: the one picked for the item, else the one the device's own page
 * resolves to (the profile chosen for that switch, host or UniFi device, else one whose match text appears in its model;
 * an infra host reports no model, so only a chosen profile counts). A picture turned off on the device's page gives none
 * from there, but a profile picked on the item itself always wins.
 */
export function pictureModelFor(item: Pick<RackItemView, "modelId" | "sourceKind" | "live">, models: readonly SwitchModel[]): SwitchModel | null {
  if (item.modelId) {
    const picked = models.find((m) => m.id === item.modelId && m.kind !== "module");
    if (picked) return picked;
  }
  if (item.sourceKind === "custom") return null;
  return resolveSwitchView(models, { model: item.live.model, switchModelId: item.live.switchModelId, switchViewOff: item.live.switchViewOff }).model;
}

/** The picture for one side of an item, or null when its model has none for that side (the elevation then draws one). */
export function rackItemPicture(item: Pick<RackItemView, "modelId" | "sourceKind" | "live">, models: readonly SwitchModel[], side: RackSide): RackPicture | null {
  const model = pictureModelFor(item, models);
  return modelPicture(model, side, model ? installedModules(model, models, item.live.portNames ?? []) : []);
}

/** `modules` are drawn only on the side the model keeps its ports on, because that is the picture they were placed on. */
export function modelPicture(model: SwitchModel | null, side: RackSide, modules: InstalledModule[] = []): RackPicture | null {
  if (!model) return null;
  const which = side === "front" ? "front" : "back";
  const imageId = which === "front" ? model.frontImageId : model.backImageId;
  const width = which === "front" ? model.frontWidth : model.backWidth;
  const height = which === "front" ? model.frontHeight : model.backHeight;
  if (!imageId || !width || !height) return null;
  return { url: switchModelImageUrl(model.id, which, imageId), width, height, modelName: model.name, modules: model.portSide === which ? modules : [] };
}
