import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type SystemMeters } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 6 fills this in. */
@Injectable()
export class HomeMetersSection implements SectionBuilder<SystemMeters> {
  async build(_ctx: HomeContext): Promise<Section<SystemMeters>> {
    return sectionOff("unavailable", "not built yet");
  }
}
