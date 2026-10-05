import { Module, Global } from "@nestjs/common";
import { MailerService } from "./mailer.service";
import { MailerController } from "./mailer.controller";
import { MailQueue } from "./mail-queue";
import { DbMailOutboxStore, MAIL_OUTBOX_STORE } from "./mail-outbox.store";

@Global()
@Module({
  providers: [MailerService, MailQueue, { provide: MAIL_OUTBOX_STORE, useClass: DbMailOutboxStore }],
  controllers: [MailerController],
  exports: [MailerService, MailQueue],
})
export class MailerModule {}
