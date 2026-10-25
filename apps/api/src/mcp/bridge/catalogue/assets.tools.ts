import { z } from "zod";
import { PERMISSIONS, assetListQuerySchema, createAssetSchema, createLocationSchema, updateAssetSchema, updateLocationSchema } from "@church/shared";
import { defineTool } from "../bridge.types";

const id = z.string().uuid();

/** Rooms and the asset inventory (docs/assets.md): reads, and adding or changing items and rooms. No check-out, delete or import. */
export const ASSET_TOOLS = [
  // ---- Rooms ----
  defineTool({
    name: "locations_list",
    title: "Rooms",
    description: "Every room (the places tickets, equipment, cabinets, monitors, hosts and printers are in), with its building and notes.",
    cls: "read",
    method: "GET",
    path: "/locations",
    permissions: [],
    input: z.object({}),
  }),
  defineTool({
    name: "locations_get_summary",
    title: "What is in a room",
    description:
      "One room and what is in it, limited to what the caller may see: equipment, cabinets, monitors, hosts, printers and open tickets. A kind the caller may not see is absent.",
    cls: "read",
    method: "GET",
    path: "/locations/:id/summary",
    permissions: [],
    input: z.object({ id }),
  }),
  defineTool({
    name: "locations_create",
    title: "Add a room",
    description: "Add a room (name unique, optional building). Check locations_list first so it is not added twice.",
    cls: "write",
    method: "POST",
    path: "/locations",
    permissions: [PERMISSIONS.LOCATIONS_ADMIN],
    input: z.object(createLocationSchema.shape),
  }),
  defineTool({
    name: "locations_update",
    title: "Change a room",
    description: "Rename a room or change its building or notes.",
    cls: "write",
    method: "PATCH",
    path: "/locations/:id",
    permissions: [PERMISSIONS.LOCATIONS_ADMIN],
    idempotent: true,
    input: z.object({ id, ...updateLocationSchema.shape }),
  }),

  // ---- Assets ----
  defineTool({
    name: "assets_list",
    title: "Equipment",
    description:
      "The equipment inventory: tag, name, category, make, model, serial, room, status, and who has it now with its due date. Filter by words (tag, name, serial, make, model), category, status, room, or holding (out, overdue, mine). Cost and purchase date are only filled in for staff.",
    cls: "read",
    method: "GET",
    path: "/assets",
    permissions: [PERMISSIONS.ASSETS_READ_ANY],
    input: assetListQuerySchema,
  }),
  defineTool({
    name: "assets_get",
    title: "Read an item",
    description: "One item of equipment with its room, status, current holder and notes.",
    cls: "read",
    method: "GET",
    path: "/assets/:id",
    permissions: [PERMISSIONS.ASSETS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "assets_get_history",
    title: "Who has had an item",
    description: "An item's check-outs, newest first: who had it, who lent it, when it was due and returned.",
    cls: "read",
    method: "GET",
    path: "/assets/:id/history",
    permissions: [PERMISSIONS.ASSETS_WRITE_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "assets_get_tickets",
    title: "Tickets about an item",
    description: "The tickets that name this item, as far as the caller may read them.",
    cls: "read",
    method: "GET",
    path: "/assets/:id/tickets",
    permissions: [PERMISSIONS.ASSETS_READ_ANY],
    input: z.object({ id }),
  }),
  defineTool({
    name: "assets_create",
    title: "Add an item",
    description:
      "Add an item of equipment. Leave tag empty for the next A-0000 number. locationId is a room id from locations_list. Search assets_list by serial first so it is not added twice.",
    cls: "write",
    method: "POST",
    path: "/assets",
    permissions: [PERMISSIONS.ASSETS_WRITE_ANY],
    input: z.object(createAssetSchema.shape),
  }),
  defineTool({
    name: "assets_update",
    title: "Change an item",
    description: "Change any field of an item: its room, status (in_service, in_repair, retired, lost), serial, notes ...",
    cls: "write",
    method: "PATCH",
    path: "/assets/:id",
    permissions: [PERMISSIONS.ASSETS_WRITE_ANY],
    idempotent: true,
    input: z.object({ id, ...updateAssetSchema.shape }),
  }),
];
