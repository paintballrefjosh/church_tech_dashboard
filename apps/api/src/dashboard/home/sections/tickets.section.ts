import { Injectable } from "@nestjs/common";
import { sectionOff, type Section, type TicketDigest } from "@church/shared";
import type { HomeContext, SectionBuilder } from "../home.types";

/** Stub: Phase 1 fills this in. */
@Injectable()
export class HomeTicketsSection implements SectionBuilder<TicketDigest> {
  async build(_ctx: HomeContext): Promise<Section<TicketDigest>> {
    return sectionOff("unavailable", "not built yet");
  }
}
