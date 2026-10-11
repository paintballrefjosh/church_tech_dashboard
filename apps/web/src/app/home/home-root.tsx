"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { LookId } from "@church/shared";
import type { LookProps } from "./look-props";

const LOOKS: Record<LookId, ComponentType<LookProps>> = {
  tiles: dynamic(() => import("./looks/tiles")),
  start: dynamic(() => import("./looks/start")),
  nave: dynamic(() => import("./looks/nave")),
  "toward-sunday": dynamic(() => import("./looks/toward-sunday")),
  glass: dynamic(() => import("./looks/glass")),
  "front-of-house": dynamic(() => import("./looks/front-of-house")),
};

export function HomeRoot({ look, ...props }: LookProps & { look: LookId }) {
  const Look = LOOKS[look];
  return <Look {...props} />;
}
