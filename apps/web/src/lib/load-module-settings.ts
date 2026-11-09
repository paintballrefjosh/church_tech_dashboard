import { KNOWN_SETTINGS } from "@lampstand/shared";
import { apiFetch } from "@/lib/api";

interface SettingsListResponse {
  items: Array<{ key: string; value: unknown }>;
}

/**
 * The settings named by `keys`, from the catalogue, with their saved values, for a module's own settings page (see
 * docs/module-settings.md). `null` when the caller may not read them (the API answers 403 unless they administer the
 * category). Secrets are masked here, on the server, so a saved password never reaches the page.
 */
export async function loadModuleSettings(keys: readonly string[]) {
  const known = keys.map((k) => KNOWN_SETTINGS.find((s) => s.key === k)).filter((s): s is (typeof KNOWN_SETTINGS)[number] => !!s);
  const res = await apiFetch("/api/v1/settings");
  if (!res.ok) return null;
  const body = (await res.json()) as SettingsListResponse;
  // A module admin gets its secrets in the clear from the API; the form only needs to know one is saved, so the
  // password never reaches the page.
  const secret = new Set(known.filter((s) => s.type === "secret").map((s) => s.key));
  const current = Object.fromEntries(
    body.items.filter((i) => keys.includes(i.key)).map((i) => [i.key, secret.has(i.key) ? (i.value === null || i.value === undefined || i.value === "" ? "" : "********") : i.value]),
  );
  return { known, current };
}

/** Every setting key in a catalogue category, in catalogue order: what a module's settings page passes to `loadModuleSettings`. */
export function settingKeysOf(category: string): string[] {
  return KNOWN_SETTINGS.filter((s) => s.category === category).map((s) => s.key);
}

/** The signed-in person's permission strings (`GET /me`), for a server page deciding which links to show. Empty when unknown. */
export async function viewerPermissions(): Promise<Set<string>> {
  const res = await apiFetch("/api/v1/me").catch(() => null);
  if (!res || !res.ok) return new Set();
  const me = (await res.json().catch(() => null)) as { permissions?: string[] } | null;
  return new Set(me?.permissions ?? []);
}
