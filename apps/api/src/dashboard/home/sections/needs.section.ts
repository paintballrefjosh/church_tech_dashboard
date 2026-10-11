import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type NeedItem } from "@church/shared";
import type { HomeContext, DerivedSectionBuilder, PrimarySections } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeNeedsSection implements DerivedSectionBuilder<NeedItem[]> {
  async build(_ctx: HomeContext, _primary: PrimarySections): Promise<Section<NeedItem[]>> {
    return sectionOff("unavailable", "not built yet");
  }
}
