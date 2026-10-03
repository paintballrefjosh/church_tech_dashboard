import { Module, Global } from "@nestjs/common";
import { MailerService } from "./mailer.service";
import { MailerController } from "./mailer.controller";
import { MailQueue } from "./mail-queue";

@Global()
@Module({
  providers: [MailerService, MailQueue],
  controllers: [MailerController],
  exports: [MailerService, MailQueue],
})
export class MailerModule {}
