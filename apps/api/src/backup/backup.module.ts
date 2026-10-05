import { Module } from "@nestjs/common";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";
import { OBJECT_STORE, S3ObjectStore } from "./object-store";

/**
 * Backups of the app's own data and restores from them (admin > Backups). Everything it needs
 * from the rest of the app (database, leases, jobs, settings, auth, search, notifications) is
 * exported by global modules.
 */
@Module({
  providers: [BackupService, { provide: OBJECT_STORE, useClass: S3ObjectStore }],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
