"use client";

import { useCallback, useEffect, useState } from "react";
import type { SwitchModel } from "@church/shared";

/**
 * A model as the page uses it. An API node that has not been upgraded yet (the nodes of a cluster upgrade one at a time)
 * answers without `kind` and `modules`: such a model is a switch with no modules.
 */
export function normaliseModel(m: SwitchModel): SwitchModel {
  return { ...m, kind: m.kind === "module" ? "module" : "switch", modules: Array.isArray(m.modules) ? m.modules : [] };
}

/** The admin's switch models (null while loading or when they cannot be read: callers fall back to the built-in layouts). */
export function useSwitchModels(): { models: SwitchModel[] | null; reload: () => Promise<void> } {
  const [models, setModels] = useState<SwitchModel[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/switch-models", { credentials: "same-origin", cache: "no-store" });
      setModels(r.ok ? ((await r.json()) as SwitchModel[]).map(normaliseModel) : []);
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { models, reload };
}

/** What went wrong, in words, from an API error answer. */
export async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  const m = body.message;
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const flat = m as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    const parts = [...(flat.formErrors ?? []), ...Object.entries(flat.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v.join(", ")}`)];
    if (parts.length) return parts.join("; ");
  }
  return `Failed (${res.status})`;
}
