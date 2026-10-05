import { Module, Global } from "@nestjs/common";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { DbLiveSearchStore, LIVE_SEARCH_STORE } from "./live-search.store";
import { DbSearchSources, SEARCH_SOURCES } from "./search-sources";

@Global()
@Module({
  providers: [
    SearchService,
    { provide: SEARCH_SOURCES, useClass: DbSearchSources },
    { provide: LIVE_SEARCH_STORE, useClass: DbLiveSearchStore },
  ],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule {}
