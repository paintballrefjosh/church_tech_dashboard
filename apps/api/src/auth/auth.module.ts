import { Module, Global } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { TotpController } from "./totp.controller";
import { MeController } from "./me.controller";

@Global()
@Module({
  providers: [AuthService],
  controllers: [AuthController, TotpController, MeController],
  exports: [AuthService],
})
export class AuthModule {}
