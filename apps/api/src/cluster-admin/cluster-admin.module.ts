import { Module } from "@nestjs/common";
import { ClusterAdminController } from "./cluster-admin.controller";
import { ClusterAdminService } from "./cluster-admin.service";

/** The admin Cluster page and the node watch. Everything it needs comes from global modules. */
@Module({ providers: [ClusterAdminService], controllers: [ClusterAdminController] })
export class ClusterAdminModule {}
