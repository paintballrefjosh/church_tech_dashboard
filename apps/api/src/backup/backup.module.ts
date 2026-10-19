import { Module } from "@nestjs/common";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";
import { OBJECT_STORE, S3ObjectStore } from "./object-store";
import { VerifyService } from "./verify.service";
import { OFFSITE_STORE_FACTORY, OffsiteService, s3OffsiteStoreFactory } from "./offsite.service";

/**
 * Backups of the app's own data and restores from them (admin > Backups). Everything it needs
 * from the rest of the app (database, leases, jobs, settings, auth, search, notifications) is
 * exported by global modules.
 */
@Module({
  providers: [
    BackupService,
    OffsiteService,
    VerifyService,
    { provide: OBJECT_STORE, useClass: S3ObjectStore },
    { provide: OFFSITE_STORE_FACTORY, useValue: s3OffsiteStoreFactory },
  ],
  controllers: [BackupController],
  exports: [BackupService, OffsiteService, VerifyService],
})
export class BackupModule {}
