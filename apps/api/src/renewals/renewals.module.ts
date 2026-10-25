import { Module } from "@nestjs/common";
import { RenewalsController } from "./renewals.controller";
import { RenewalsService } from "./renewals.service";

/** Renewals and their reminders. DB, notifications and cluster jobs come from global modules. */
@Module({ controllers: [RenewalsController], providers: [RenewalsService] })
export class RenewalsModule {}
