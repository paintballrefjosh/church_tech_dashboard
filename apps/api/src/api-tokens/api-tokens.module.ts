import { Module } from "@nestjs/common";
import { AdminApiTokensController, MeApiTokensController } from "./api-tokens.controller";
import { ApiTokensService } from "./api-tokens.service";

@Module({
  providers: [ApiTokensService],
  controllers: [MeApiTokensController, AdminApiTokensController],
})
export class ApiTokensModule {}
