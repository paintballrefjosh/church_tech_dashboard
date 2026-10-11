import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type WikiDigest } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeWikiSection implements SectionBuilder<WikiDigest> {
  async build(_ctx: HomeContext): Promise<Section<WikiDigest>> {
    return sectionOff("unavailable", "not built yet");
  }
}
