import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type AvailabilityGrid } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 5b fills this in. */
@Injectable()
export class HomeAvailabilitySection implements SectionBuilder<AvailabilityGrid> {
  async build(_ctx: HomeContext): Promise<Section<AvailabilityGrid>> {
    return sectionOff("unavailable", "not built yet");
  }
}
