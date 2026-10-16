import { Module } from "@nestjs/common";
import { SecurityPostureController } from "./security-posture.controller";
import { SecurityPostureService } from "./security-posture.service";

@Module({ controllers: [SecurityPostureController], providers: [SecurityPostureService] })
export class SecurityPostureModule {}
