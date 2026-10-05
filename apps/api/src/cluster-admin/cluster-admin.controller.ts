import { BadRequestException, Controller, Delete, Get, Param } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { ClusterAdminService } from "./cluster-admin.service";

/** The admin Cluster page's data: nodes, jobs, database, object store, problems. site:admin. */
@Controller("admin/cluster")
@RequirePermissions(PERMISSIONS.SITE_ADMIN)
export class ClusterAdminController {
  constructor(private readonly cluster: ClusterAdminService) {}

  @Get()
  status() {
    return this.cluster.status();
  }

  /** Forget a node that is not checking in and is not coming back. */
  @Delete("nodes/:id")
  @Audited({ action: "cluster.node.forget", resourceType: "cluster_node", resourceIdFromParams: (p) => p.id ?? null })
  forget(@Param("id") id: string) {
    if (!z.string().min(1).max(100).safeParse(id).success) throw new BadRequestException("Invalid node id");
    return this.cluster.forgetNode(id);
  }
}
