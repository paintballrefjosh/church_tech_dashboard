import { Controller, Get, Post, Patch, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import {
  PERMISSIONS,
  createIpamSubnetSchema,
  updateIpamSubnetSchema,
  updateIpamHostSchema,
  cidrSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { IpamService } from "./ipam.service";
import { IpamScanner } from "./ipam.scanner";
import { DnsSyncService } from "../dns/dns.sync";

/**
 * IPAM API for the IPAM page (part of the monitoring module). Reads require the monitoring
 * module at any tier (monitors:read:any); every mutation requires the admin
 * tier (monitors:write:any). Scans are fire-and-forget: the endpoint kicks the
 * sweep off in the background and returns immediately; the UI re-fetches.
 */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

const adoptSchema = z.object({
  cidr: cidrSchema,
  source: z.enum(["manual", "cisco", "unifi"]).optional(),
  sourceDetail: z.string().max(128).nullable().optional(),
  vlanId: z.number().int().min(1).max(4094).nullable().optional(),
  gateway: z.string().max(45).nullable().optional(),
  label: z.string().max(128).nullable().optional(),
});

@Controller("ipam")
export class IpamController {
  constructor(
    private readonly ipam: IpamService,
    private readonly scanner: IpamScanner,
    private readonly dnsSync: DnsSyncService,
  ) {}

  @Get("summary")
  @RequirePermissions(READ)
  summary() {
    return this.ipam.summary();
  }

  // ---- subnets ----
  @Get("subnets")
  @RequirePermissions(READ)
  listSubnets() {
    return this.ipam.list();
  }

  @Get("subnets/:id")
  @RequirePermissions(READ)
  getSubnet(@Param("id") id: string) {
    return this.ipam.getById(id);
  }

  @Post("subnets")
  @RequirePermissions(WRITE)
  @Audited({ action: "ipam.subnet.create", resourceType: "ipam_subnet" })
  async createSubnet(@Body() body: unknown) {
    const parsed = createIpamSubnetSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const subnet = await this.ipam.create(parsed.data);
    if (subnet.scanEnabled) void this.scanner.scanSubnetById(subnet.id).catch(() => undefined);
    return subnet;
  }

  @Patch("subnets/:id")
  @RequirePermissions(WRITE)
  @Audited({ action: "ipam.subnet.update", resourceType: "ipam_subnet" })
  async updateSubnet(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateIpamSubnetSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const subnet = await this.ipam.update(id, parsed.data);
    // Publishing toggled: let the DNS sync catch up (no-op while sync is off).
    if (parsed.data.dnsSync !== undefined) this.dnsSync.requestRun("ipam-edit");
    return subnet;
  }

  @Patch("hosts/:id")
  @RequirePermissions(WRITE)
  @Audited({ action: "ipam.host.update", resourceType: "ipam_host" })
  async updateHost(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateIpamHostSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const host = await this.ipam.updateHost(id, parsed.data);
    if (parsed.data.dnsName !== undefined) this.dnsSync.requestRun("ipam-edit");
    return host;
  }

  @Delete("subnets/:id")
  @RequirePermissions(WRITE)
  @Audited({ action: "ipam.subnet.delete", resourceType: "ipam_subnet" })
  deleteSubnet(@Param("id") id: string) {
    return this.ipam.remove(id);
  }

  @Get("subnets/:id/hosts")
  @RequirePermissions(READ)
  hosts(@Param("id") id: string) {
    return this.ipam.hosts(id);
  }

  @Post("subnets/:id/scan")
  @RequirePermissions(WRITE)
  @Audited({ action: "ipam.subnet.scan", resourceType: "ipam_subnet" })
  scan(@Param("id") id: string) {
    void this.scanner.scanSubnetById(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  // ---- discovery ----
  @Get("discover")
  @RequirePermissions(READ)
  discover() {
    return this.ipam.discover();
  }

  @Post("adopt")
  @RequirePermissions(WRITE)
  @Audited({ action: "ipam.subnet.adopt", resourceType: "ipam_subnet" })
  async adopt(@Body() body: unknown) {
    const parsed = adoptSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const subnet = await this.ipam.adopt(parsed.data);
    void this.scanner.scanSubnetById(subnet.id).catch(() => undefined);
    return subnet;
  }
}
