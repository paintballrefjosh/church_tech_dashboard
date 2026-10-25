import { Injectable, Inject, NotFoundException, BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { asc, eq, isNotNull } from "drizzle-orm";
import { ciscoSheetRows, unifiSheetRows, type PortSheet, type UnifiPortLike, type UnifiOverrideLike, type VlanLookup } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { ciscoSwitches, ciscoVlanDb, ipamSubnets } from "../db/schema";
import { CiscoService } from "../cisco/cisco.service";
import { UnifiService } from "../unifi/unifi.service";
import { normaliseMac } from "./racks.service";

interface UnifiDeviceRaw {
  mac?: string;
  name?: string;
  model?: string;
  ip?: string;
  port_table?: UnifiPortLike[];
  port_overrides?: UnifiOverrideLike[];
}

/**
 * The data behind the printable port sheets: one object per device, with a row per port (see
 * packages/shared/src/port-sheet.ts for the row rules). Read-only; nothing here touches a device.
 */
@Injectable()
export class PortSheetsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cisco: CiscoService,
    private readonly unifi: UnifiService,
  ) {}

  async forCisco(switchId: string): Promise<PortSheet> {
    const [sw] = await this.db.select().from(ciscoSwitches).where(eq(ciscoSwitches.id, switchId)).limit(1);
    if (!sw) throw new NotFoundException("Switch not found");
    const [ports, vlanRows, subnetRows] = await Promise.all([
      this.cisco.portsForSwitch(switchId),
      this.db.select({ vlanId: ciscoVlanDb.vlanId, vlanName: ciscoVlanDb.vlanName }).from(ciscoVlanDb).where(eq(ciscoVlanDb.switchId, switchId)),
      this.db
        .select({ cidr: ipamSubnets.cidr, vlanId: ipamSubnets.vlanId, source: ipamSubnets.source, sourceDetail: ipamSubnets.sourceDetail })
        .from(ipamSubnets)
        .where(isNotNull(ipamSubnets.vlanId))
        .orderBy(asc(ipamSubnets.cidr)),
    ]);

    const names = new Map(vlanRows.map((v) => [v.vlanId, v.vlanName?.trim() || null]));
    // This switch's own SVIs first: the same VLAN number can be a different network elsewhere.
    const ranked = [...subnetRows].sort((a, b) => Number(b.source === "cisco" && b.sourceDetail === sw.hostname) - Number(a.source === "cisco" && a.sourceDetail === sw.hostname));
    const subnets = new Map<number, string[]>();
    for (const s of ranked) {
      if (s.vlanId === null) continue;
      const list = subnets.get(s.vlanId) ?? [];
      if (!list.includes(s.cidr)) list.push(s.cidr);
      subnets.set(s.vlanId, list);
    }
    const lookup: VlanLookup = { name: (id) => names.get(id) ?? null, subnets: (id) => subnets.get(id) ?? [] };

    const notes: string[] = [];
    if (subnets.size === 0) notes.push("No subnets are recorded against VLANs yet. Add them on the IPAM page (a VLAN number on the subnet) and they appear here.");
    if (vlanRows.length === 0) notes.push("This switch has not reported its VLAN names yet.");
    return {
      kind: "cisco",
      device: { id: sw.id, name: sw.hostname, ip: sw.ipAddress, model: sw.model, location: sw.location, switchModelId: sw.switchModelId, switchViewOff: sw.switchViewOff },
      generatedAt: new Date().toISOString(),
      ports: ciscoSheetRows(ports, lookup),
      notes,
    };
  }

  async forUnifi(macParam: string): Promise<PortSheet> {
    const mac = normaliseMac(macParam);
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) throw new BadRequestException("That is not a MAC address");
    let devices: UnifiDeviceRaw[];
    try {
      devices = (await this.unifi.devices()) as UnifiDeviceRaw[];
    } catch (err) {
      throw new ServiceUnavailableException(err instanceof Error ? err.message : "The UniFi controller could not be reached");
    }
    const dev = devices.find((d) => d.mac && normaliseMac(d.mac) === mac);
    if (!dev) throw new NotFoundException("The UniFi controller does not list that device");
    if (!Array.isArray(dev.port_table) || dev.port_table.length === 0) {
      throw new BadRequestException("That device has no switch ports to list (it is not a switch or gateway with a port table)");
    }
    const [profiles, networks] = await Promise.all([this.unifi.portProfiles(), this.unifi.networkConfs()]);
    const notes: string[] = [];
    if (profiles === null || networks === null) {
      notes.push("The controller's port profiles or networks could not be read, so VLANs and subnets are left blank.");
    }
    return {
      kind: "unifi",
      device: { id: mac, name: dev.name?.trim() || mac, ip: dev.ip ?? null, model: dev.model ?? null, location: null },
      generatedAt: new Date().toISOString(),
      ports: unifiSheetRows(dev, profiles ?? [], networks ?? []),
      notes,
    };
  }
}
