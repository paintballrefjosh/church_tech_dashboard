import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { DbModule } from "./db/db.module";
import { HealthModule } from "./health/health.module";
import { MetricsModule } from "./metrics/metrics.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { GroupsModule } from "./groups/groups.module";
import { RolesModule } from "./roles/roles.module";
import { AuditModule } from "./audit/audit.module";
import { SettingsModule } from "./settings/settings.module";
import { NotesModule } from "./notes/notes.module";
import { TicketsModule } from "./tickets/tickets.module";
import { WikiModule } from "./wiki/wiki.module";
import { AttachmentsModule } from "./attachments/attachments.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SessionGuard } from "./auth/session.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { AuditInterceptor } from "./audit/audit.interceptor";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        transport:
          process.env.NODE_ENV === "production"
            ? undefined
            : { target: "pino-pretty", options: { colorize: true, singleLine: true } },
        redact: ["req.headers.cookie", "req.headers.authorization"],
      },
    }),
    DbModule,
    HealthModule,
    MetricsModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    RolesModule,
    AuditModule,
    SettingsModule,
    RealtimeModule,
    AttachmentsModule,
    NotesModule,
    TicketsModule,
    WikiModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
