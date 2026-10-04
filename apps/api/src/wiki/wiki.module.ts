import { Module } from "@nestjs/common";
import { WikiController } from "./wiki.controller";
import { WikiService } from "./wiki.service";
import { WikiWritesService } from "./wiki-writes.service";
import { WikiFoldersController } from "./wiki-folders.controller";
import { WikiFoldersService } from "./wiki-folders.service";
import { WikiImportService } from "./import/wiki-import.service";
import { RealtimeModule } from "../realtime/realtime.module";

@Module({
  imports: [RealtimeModule],
  controllers: [WikiController, WikiFoldersController],
  providers: [WikiService, WikiWritesService, WikiFoldersService, WikiImportService],
  // The MCP server's wiki tools use the same services as the REST routes.
  exports: [WikiService, WikiWritesService, WikiFoldersService],
})
export class WikiModule {}
