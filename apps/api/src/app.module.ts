import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { DbModule } from "./db/db.module";
import { HealthModule } from "./health/health.module";
import { MetricsModule } from "./metrics/metrics.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { GroupsModule } from "./groups/groups.module";
import { AuditModule } from "./audit/audit.module";
import { SettingsModule } from "./settings/settings.module";
import { NotesModule } from "./notes/notes.module";
import { TicketsModule } from "./tickets/tickets.module";
import { WikiModule } from "./wiki/wiki.module";
import { AttachmentsModule } from "./attachments/attachments.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { MailerModule } from "./mailer/mailer.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { InfraModule } from "./infra/infra.module";
import { PrintersModule } from "./printers/printers.module";
import { UnifiModule } from "./unifi/unifi.module";
import { PropresenterModule } from "./propresenter/propresenter.module";
import { SearchModule } from "./search/search.module";
import { TagsModule } from "./tags/tags.module";
import { TicketCategoriesModule } from "./ticket-categories/ticket-categories.module";
import { MentionsModule } from "./mentions/mentions.module";
import { ActivityModule } from "./activity/activity.module";
import { PlanningCenterModule } from "./planning-center/planning-center.module";
import { ChecklistsModule } from "./checklists/checklists.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SavedViewsModule } from "./saved-views/saved-views.module";
import { AuthTokensModule } from "./auth-tokens/auth-tokens.module";
import { CiscoModule } from "./cisco/cisco.module";
import { IpamModule } from "./ipam/ipam.module";
import { UpsModule } from "./ups/ups.module";
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
    AuditModule,
    SettingsModule,
    RealtimeModule,
    AttachmentsModule,
    MailerModule,
    NotificationsModule,
    NotesModule,
    TicketsModule,
    WikiModule,
    DashboardModule,
    MonitorsModule,
    InfraModule,
    PrintersModule,
    UnifiModule,
    PropresenterModule,
    SearchModule,
    TagsModule,
    TicketCategoriesModule,
    MentionsModule,
    ActivityModule,
    PlanningCenterModule,
    ChecklistsModule,
    SavedViewsModule,
    AuthTokensModule,
    CiscoModule,
    IpamModule,
    UpsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
