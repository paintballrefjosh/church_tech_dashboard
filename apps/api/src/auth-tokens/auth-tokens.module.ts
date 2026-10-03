import { Module } from "@nestjs/common";
import { AuthTokensService } from "./auth-tokens.service";
import { AuthTokensController } from "./auth-tokens.controller";

@Module({
  providers: [AuthTokensService],
  controllers: [AuthTokensController],
  exports: [AuthTokensService],
})
export class AuthTokensModule {}
