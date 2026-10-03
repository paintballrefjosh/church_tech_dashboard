import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { RealtimeModule } from "../realtime/realtime.module";
import { AuthTokensModule } from "../auth-tokens/auth-tokens.module";

@Module({
  imports: [RealtimeModule, AuthTokensModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
