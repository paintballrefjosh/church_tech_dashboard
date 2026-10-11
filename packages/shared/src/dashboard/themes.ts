import { z } from "zod";
import { PERMISSIONS, type PermissionString } from "../permissions";
import type { HomeInclude } from "./home";

export const LOOK_IDS = ["tiles", "start", "nave", "toward-sunday", "glass", "front-of-house"] as const;
export type LookId = (typeof LOOK_IDS)[number];

export interface OptionalSection {
  id: string;
  label: string;
}

export interface LookDefinition {
  id: LookId;
  name: string;
  description: string;
  requires: PermissionString[];
  includes: HomeInclude[];
  /** Blocks a person may hide on this look. The look's signature is never listed. */
  optionalSections: OptionalSection[];
  thumbnails: { light: string; dark: string };
}

const thumbs = (id: LookId) => ({
  light: `/home-looks/${id}-light.png`,
  dark: `/home-looks/${id}-dark.png`,
});

export const DASHBOARD_LOOKS: readonly LookDefinition[] = [
  {
    id: "tiles",
    name: "Tiles",
    description: "The draggable tile grid you know, unchanged.",
    requires: [],
    includes: [],
    optionalSections: [],
    thumbnails: thumbs("tiles"),
  },
  {
    id: "start",
    name: "Start page",
    description: "A written summary of your day, search, and one list of what needs you.",
    requires: [],
    includes: [],
    optionalSections: [{ id: "needs", label: "Needs you" }, { id: "service", label: "Next service" }, { id: "systems", label: "Systems" }, { id: "recent", label: "Recently changed" }, { id: "create", label: "Create shortcuts" }],
    thumbnails: thumbs("start"),
  },
  {
    id: "nave",
    name: "Nave",
    description: "The sign-in arches as the hero, with arched panels for the week ahead.",
    requires: [],
    includes: [],
    optionalSections: [{ id: "systems", label: "Systems" }, { id: "team", label: "Team" }, { id: "foryou", label: "For you" }, { id: "week", label: "This week" }, { id: "wiki", label: "Wiki" }, { id: "create", label: "Start something" }],
    thumbnails: thumbs("nave"),
  },
  {
    id: "toward-sunday",
    name: "Toward Sunday",
    description: "A Monday to Sunday rail with a readiness score for the next service.",
    requires: [],
    includes: ["week", "readiness"],
    optionalSections: [{ id: "readiness", label: "Readiness" }, { id: "needs", label: "Needs you" }, { id: "team", label: "Team" }, { id: "create", label: "Create and wiki changes" }],
    thumbnails: thumbs("toward-sunday"),
  },
  {
    id: "glass",
    name: "Glass",
    description: "A stained-glass mosaic of system uptime, hour by hour.",
    requires: [PERMISSIONS.MONITORS_READ_ANY],
    includes: ["availability"],
    optionalSections: [{ id: "service", label: "Next service" }, { id: "needs", label: "For you" }, { id: "create", label: "Start something" }, { id: "wiki", label: "Changed in the wiki" }],
    thumbnails: thumbs("glass"),
  },
  {
    id: "front-of-house",
    name: "Front of House",
    description: "Channel strips with live meters, and maintenance mode as a mute switch.",
    requires: [PERMISSIONS.MONITORS_READ_ANY],
    includes: ["meters"],
    optionalSections: [{ id: "team", label: "Team" }, { id: "checklist", label: "Checklist" }, { id: "helpdesk", label: "Help desk" }],
    thumbnails: thumbs("front-of-house"),
  },
];

export const LOOK_DEVICE_COOKIE = "church_home_look";

export function isLookId(v: unknown): v is LookId {
  return typeof v === "string" && (LOOK_IDS as readonly string[]).includes(v);
}

export interface ResolveLookInput {
  urlParam?: string | null;
  deviceCookie?: string | null;
  userPref?: string | null;
  siteDefault?: string | null;
  enabled: readonly string[];
  permissions: readonly string[];
}

export type LookSource = "url" | "device" | "user" | "site" | "fallback";

/**
 * Picks the look to render. Candidates in order: URL parameter, device cookie, the person's saved
 * choice, the site default. The first that is a known id, enabled by the admin, and whose required
 * permissions the person holds wins. `start` is the final fallback and is always allowed.
 */
export function resolveLook(input: ResolveLookInput): { look: LookId; source: LookSource } {
  const candidates: Array<[LookSource, string | null | undefined]> = [
    ["url", input.urlParam],
    ["device", input.deviceCookie],
    ["user", input.userPref],
    ["site", input.siteDefault],
  ];
  for (const [source, id] of candidates) {
    if (!isLookId(id)) continue;
    if (!input.enabled.includes(id)) continue;
    const def = DASHBOARD_LOOKS.find((l) => l.id === id);
    if (!def) continue;
    if (!def.requires.every((p) => input.permissions.includes(p))) continue;
    return { look: id, source };
  }
  return { look: "start", source: "fallback" };
}

/** Section ids this look knows how to hide. */
export function optionalSectionIds(look: LookId): string[] {
  return (DASHBOARD_LOOKS.find((l) => l.id === look)?.optionalSections ?? []).map((s) => s.id);
}

/** Drops ids the look does not offer, and repeats. */
export function cleanLookSections(look: string, ids: readonly string[]): string[] {
  if (!isLookId(look)) return [];
  const known = optionalSectionIds(look);
  return [...new Set(ids)].filter((id) => known.includes(id));
}

const lookIdSchema = z.enum(LOOK_IDS);
const sectionIdsSchema = z.array(z.string().min(1).max(64)).max(50);
const sectionsSchema = z.record(lookIdSchema, sectionIdsSchema);

export const dashboardPrefsSchema = z.object({
  theme: lookIdSchema.nullable(),
  sections: sectionsSchema,
});
export type DashboardPrefs = z.infer<typeof dashboardPrefsSchema>;

export const updateDashboardPrefsSchema = z.object({
  theme: lookIdSchema.nullable().optional(),
  sections: sectionsSchema.optional(),
});
export type UpdateDashboardPrefs = z.infer<typeof updateDashboardPrefsSchema>;
