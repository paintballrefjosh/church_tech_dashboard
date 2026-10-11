"use client";

import { DashboardGrid } from "../../../dashboard-tiles/dashboard-grid";
import type { LookProps } from "../../look-props";

export default function TilesLook({ me, tiles }: LookProps) {
  if (!tiles) return null;
  return (
    <main data-look="tiles" className="fx-surface mx-auto max-w-6xl px-4 py-6">
      <DashboardGrid initialLayout={tiles.layout} access={me.access} initialData={tiles.initialData} />
    </main>
  );
}
