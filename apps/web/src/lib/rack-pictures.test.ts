import { describe, expect, it } from "vitest";
import type { RackItemView, SwitchModel } from "@church/shared";
import { pictureModelFor } from "./rack-pictures";

const NOW = "2026-10-25T00:00:00.000Z";
const profile = (id: string, name: string, match: string[], kind: "switch" | "module" = "switch") =>
  ({
    id,
    name,
    kind,
    match,
    portSide: "front",
    frontImageId: null,
    backImageId: null,
    frontWidth: null,
    frontHeight: null,
    backWidth: null,
    backHeight: null,
    ports: [],
    modules: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as SwitchModel;

const SERVER = profile("11111111-1111-4111-8111-111111111111", "Dell R740", []);
const USW = profile("22222222-2222-4222-8222-222222222222", "USW Pro 24", ["USW24P"]);
const OTHER = profile("33333333-3333-4333-8333-333333333333", "Another switch", []);
const MOD = profile("44444444-4444-4444-8444-444444444444", "Uplink module", ["USW24P"], "module");
const ALL = [SERVER, USW, OTHER, MOD];

type Item = Pick<RackItemView, "modelId" | "sourceKind" | "live">;
const item = (sourceKind: Item["sourceKind"], live: Partial<Item["live"]>, modelId: string | null = null): Item =>
  ({ modelId, sourceKind, live: { model: null, switchModelId: null, switchViewOff: false, portNames: [], ...live } }) as unknown as Item;

describe("pictureModelFor", () => {
  it("an infra host has no model text: the profile chosen for it on its page, else none", () => {
    expect(pictureModelFor(item("infra", {}), ALL)).toBeNull();
    expect(pictureModelFor(item("infra", { switchModelId: SERVER.id }), ALL)).toBe(SERVER);
  });

  it("a UniFi device is matched on its model text unless a profile was chosen or its picture turned off", () => {
    expect(pictureModelFor(item("unifi", { model: "USW24P" }), ALL)).toBe(USW);
    expect(pictureModelFor(item("unifi", { model: "USW24P", switchModelId: OTHER.id }), ALL)).toBe(OTHER);
    expect(pictureModelFor(item("unifi", { model: "USW24P", switchViewOff: true }), ALL)).toBeNull();
  });

  it("a profile picked on the cabinet item wins over everything, but never a module", () => {
    expect(pictureModelFor(item("unifi", { model: "USW24P", switchViewOff: true }, OTHER.id), ALL)).toBe(OTHER);
    expect(pictureModelFor(item("infra", { switchModelId: SERVER.id }, MOD.id), ALL)).toBe(SERVER);
    expect(pictureModelFor(item("custom", { switchModelId: SERVER.id }), ALL)).toBeNull();
  });

  it("a chosen profile that was deleted counts as no choice", () => {
    expect(pictureModelFor(item("infra", { switchModelId: "55555555-5555-4555-8555-555555555555" }), ALL)).toBeNull();
  });
});
