import { Module, Global } from "@nestjs/common";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";

@Global()
@Module({
  providers: [SearchService],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule {}
