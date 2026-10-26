import { Module } from "@nestjs/common";
import { LivestreamsController } from "./livestreams.controller";
import { LivestreamsService } from "./livestreams.service";
import { LivestreamChecker } from "./livestream-checker";

/** Livestream checks. DB, settings, notifications, infra (monitoring recipients) and cluster jobs come from global modules. */
@Module({ controllers: [LivestreamsController], providers: [LivestreamsService, LivestreamChecker] })
export class LivestreamsModule {}
