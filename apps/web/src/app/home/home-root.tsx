"use client";

import dynamic from "next/dynamic";
import { useMemo, type ComponentType } from "react";
import type { LookId } from "@church/shared";
import type { LookProps } from "./look-props";
import { HomeLookContext, type HomeLookContextValue } from "./home-look-context";

export { HomeLookContext, useHomeLook } from "./home-look-context";

const LOOKS: Record<LookId, ComponentType<LookProps>> = {
  tiles: dynamic(() => import("./looks/tiles")),
  start: dynamic(() => import("./looks/start")),
  nave: dynamic(() => import("./looks/nave")),
  "toward-sunday": dynamic(() => import("./looks/toward-sunday")),
  glass: dynamic(() => import("./looks/glass")),
  "front-of-house": dynamic(() => import("./looks/front-of-house")),
};

export type HomeRootProps = LookProps & Omit<HomeLookContextValue, "kiosk">;

/**
 * Renders the chosen look inside a context that tells any part of it which look this is, where
 * that choice came from and which looks the person may switch to (what the picker button needs).
 */
export function HomeRoot({ look, source, available, siteDefault, ...props }: HomeRootProps) {
  const Look = LOOKS[look];
  const value = useMemo<HomeLookContextValue>(
    () => ({ look, source, available, siteDefault, kiosk: props.kiosk }),
    [look, source, available, siteDefault, props.kiosk],
  );
  return (
    <HomeLookContext.Provider value={value}>
      <Look {...props} />
    </HomeLookContext.Provider>
  );
}
