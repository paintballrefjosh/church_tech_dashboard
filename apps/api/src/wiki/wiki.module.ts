import { Module } from "@nestjs/common";
import { WikiController } from "./wiki.controller";
import { WikiService } from "./wiki.service";
import { WikiWritesService } from "./wiki-writes.service";
import { WikiFoldersController } from "./wiki-folders.controller";
import { WikiFoldersService } from "./wiki-folders.service";
import { WikiTemplatesController } from "./wiki-templates.controller";
import { WikiTemplatesService } from "./wiki-templates.service";
import { WikiReview } from "./wiki-review";
import { WikiImportService } from "./import/wiki-import.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [WikiController, WikiFoldersController, WikiTemplatesController],
  providers: [WikiService, WikiWritesService, WikiFoldersService, WikiImportService, WikiTemplatesService, WikiReview],
  // The MCP server's wiki tools use the same services as the REST routes.
  exports: [WikiService, WikiWritesService, WikiFoldersService, WikiTemplatesService],
})
export class WikiModule {}
