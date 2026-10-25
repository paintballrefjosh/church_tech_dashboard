import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

/** The monthly report. DB, notifications, settings, job state and cluster jobs come from global modules. */
@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
