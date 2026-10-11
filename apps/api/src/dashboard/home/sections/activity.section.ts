import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type ActivityItem } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeActivitySection implements SectionBuilder<ActivityItem[]> {
  async build(_ctx: HomeContext): Promise<Section<ActivityItem[]>> {
    return sectionOff("unavailable", "not built yet");
  }
}
