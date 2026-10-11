import type { HomeSnapshot, Section } from "@church/shared";

const off = <T>(): Section<T> => ({ state: "unavailable", reason: "not loaded" });

/**
 * A snapshot with every section unavailable. The tiles look ignores the snapshot (it has its own
 * data), so the page passes this instead of making a snapshot request.
 */
export function emptySnapshot(): HomeSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    timezone: "UTC",
    dayPart: "morning",
    user: { id: "", firstName: "" },
    site: { name: "", tagline: "" },
    service: off(),
    systems: off(),
    needs: off(),
    tickets: off(),
    checklists: off(),
    wiki: off(),
    notes: off(),
    activity: off(),
  };
}
