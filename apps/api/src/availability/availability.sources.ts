import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { ciscoSwitches, infraTargets, monitors } from "../db/schema";
import { UnifiService } from "../unifi/unifi.service";
import { DnsService } from "../dns/dns.service";
import type { AvailabilitySample } from "./availability.store";

/**
 * Where the sampler reads current state. Each method returns the samples for one kind, or null
 * when that kind has no data this tick (unconfigured, unreachable). A throw is treated the same.
 */
export interface AvailabilitySources {
  monitors(): Promise<AvailabilitySample[] | null>;
  infraTargets(): Promise<AvailabilitySample[] | null>;
  unifiDevices(): Promise<AvailabilitySample[] | null>;
  ciscoSwitches(): Promise<AvailabilitySample[] | null>;
  dnsNodes(): Promise<AvailabilitySample[] | null>;
}

export const AVAILABILITY_SOURCES = Symbol("AVAILABILITY_SOURCES");

interface RawDevice {
  state?: number;
  mac?: string;
  name?: string;
  model?: string;
}

const HEALTHY_NODE_STATES = new Set(["Self", "Connected"]);

@Injectable()
export class DefaultAvailabilitySources implements AvailabilitySources {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly unifi: UnifiService,
    private readonly dns: DnsService,
  ) {}

  async monitors(): Promise<AvailabilitySample[]> {
    const rows = await this.db
      .select({ id: monitors.id, name: monitors.name, status: monitors.status, lastCheckedAt: monitors.lastCheckedAt })
      .from(monitors)
      .where(eq(monitors.enabled, true));
    return rows
      .filter((r) => r.lastCheckedAt !== null && (r.status === "up" || r.status === "down"))
      .map((r) => ({ kind: "monitor" as const, ref: r.id, label: r.name, down: r.status === "down" }));
  }

  async infraTargets(): Promise<AvailabilitySample[]> {
    const rows = await this.db
      .select({ id: infraTargets.id, name: infraTargets.name, status: infraTargets.status })
      .from(infraTargets)
      .where(eq(infraTargets.enabled, true));
    return rows
      .filter((r) => r.status !== "unknown")
      .map((r) => ({ kind: "infra_target" as const, ref: r.id, label: r.name, down: r.status === "down" }));
  }

  async unifiDevices(): Promise<AvailabilitySample[]> {
    // devices() returns [] when unconfigured and throws when the controller is unreachable.
    const devices = (await this.unifi.devices()) as RawDevice[];
    return devices
      .filter((d) => !!d.mac)
      .map((d) => ({
        kind: "unifi_device" as const,
        ref: (d.mac as string).toLowerCase(),
        label: d.name || d.model || (d.mac as string),
        down: d.state !== 1,
      }));
  }

  async ciscoSwitches(): Promise<AvailabilitySample[]> {
    const rows = await this.db
      .select({ id: ciscoSwitches.id, hostname: ciscoSwitches.hostname, reachable: ciscoSwitches.reachable })
      .from(ciscoSwitches);
    return rows.map((r) => ({ kind: "cisco_switch" as const, ref: r.id, label: r.hostname, down: !r.reachable }));
  }

  async dnsNodes(): Promise<AvailabilitySample[] | null> {
    const s = await this.dns.summary();
    // Primary unreachable or no cluster node list: no data, not "down".
    if (!s.configured || !s.reachable || !s.nodes) return null;
    return s.nodes.map((n) => {
      const ref = n.name || n.ipAddress || n.url || "unknown";
      return {
        kind: "dns_node" as const,
        ref,
        label: n.name || n.ipAddress || ref,
        down: !HEALTHY_NODE_STATES.has(n.state),
      };
    });
  }
}
