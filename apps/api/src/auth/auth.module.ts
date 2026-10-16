import { Module, Global } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { TotpController } from "./totp.controller";
import { MeController } from "./me.controller";
import { SessionsService } from "./sessions.service";

@Global()
@Module({
  providers: [AuthService, SessionsService],
  controllers: [AuthController, TotpController, MeController],
  exports: [AuthService, SessionsService],
})
export class AuthModule {}
