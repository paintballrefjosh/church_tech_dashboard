"use client";

import { createContext, useContext } from "react";
import type { LookId, LookSource } from "@church/shared";

export interface HomeLookContextValue {
  /** The look being shown. */
  look: LookId;
  /** Why this look was chosen: the URL, this device's cookie, the person's choice, or the site default. */
  source: LookSource;
  /** Looks this person may choose. */
  available: LookId[];
  /** The site's default look. */
  siteDefault: LookId;
  /** Booth screen: no editing chrome, so the picker stays out of the way. */
  kiosk: boolean;
  /** Ids of the optional sections this person hid on the current look. */
  hiddenSections: string[];
}

export const HomeLookContext = createContext<HomeLookContextValue | null>(null);

/** The current look and what the picker needs; null outside the home page. */
export function useHomeLook(): HomeLookContextValue | null {
  return useContext(HomeLookContext);
}

/** Whether an optional section of the current look should be left out. */
export function useSectionHidden(): (id: string) => boolean {
  const ctx = useContext(HomeLookContext);
  const hidden = ctx?.hiddenSections;
  return (id) => (hidden ? hidden.includes(id) : false);
}
