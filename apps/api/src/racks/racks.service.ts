import { Injectable, Inject, Logger, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  MAX_RACK_ITEMS,
  defaultRackStyle,
  placementProblem,
  topU,
  usedUnits,
  type CreateRackInput,
  type CreateRackItemInput,
  type Rack,
  type RackCandidate,
  type RackDetail,
  type RackItemLive,
  type RackItemRow,
  type RackItemStyle,
  type RackItemView,
  type RackListEntry,
  type RackSourceKind,
  type UpdateRackInput,
  type UpdateRackItemInput,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { ciscoSwitches, infraTargets, rackItems, racks, switchModels } from "../db/schema";
import { UnifiService } from "../unifi/unifi.service";
import { TtlCache } from "../dashboard/home/cache";

type RackRowDb = typeof racks.$inferSelect;
type ItemRowDb = typeof rackItems.$inferSelect;

/** The few fields of a UniFi device the cabinet reads. */
interface UDev {
  mac?: string;
  name?: string;
  model?: string;
  ip?: string;
  state?: number;
  type?: string;
}

/** A device read from its own system, in the one shape the cabinet needs. */
interface Known {
  name: string;
  hostname: string | null;
  ip: string | null;
  model: string | null;
  status: "up" | "down" | "unknown";
  href: string | null;
  style: RackItemStyle;
  switchModelId: string | null;
  switchViewOff: boolean;
}

const UNIFI_READ_TTL_MS = 15_000;
const UNIFI_FAIL_TTL_MS = 20_000;
const UNIFI_DEADLINE_MS = 3_000;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normaliseMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/-/g, ":");
}

function unifiStyle(type: string | undefined): RackItemStyle {
  switch (type) {
    case "uap":
      return "access_point";
    case "ugw":
    case "udm":
    case "uxg":
      return "gateway";
    default:
      return "switch";
  }
}

function toRack(r: RackRowDb): Rack {
  return { id: r.id, name: r.name, location: r.location, units: r.units, notes: r.notes, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

function toItem(r: ItemRowDb): RackItemRow {
  return {
    id: r.id,
    rackId: r.rackId,
    sourceKind: r.sourceKind as RackSourceKind,
    sourceId: r.sourceId,
    label: r.label,
    hostname: r.hostname,
    ip: r.ip,
    style: r.style as RackItemStyle,
    startU: r.startU,
    heightU: r.heightU,
    modelId: r.modelId,
    notes: r.notes,
  };
}

/** What a custom item says about itself, and what a linked one falls back to when its device cannot be read. */
function ownLive(item: RackItemRow, missing: boolean): RackItemLive {
  return {
    name: item.label,
    hostname: item.hostname,
    ip: item.ip,
    model: null,
    status: "unknown",
    missing,
    href: null,
    switchModelId: null,
    switchViewOff: false,
  };
}

@Injectable()
export class RacksService {
  private readonly logger = new Logger(RacksService.name);
  private readonly cache = new TtlCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly unifi: UnifiService,
  ) {}

  // ---- cabinets ----

  async list(): Promise<RackListEntry[]> {
    const [rackRows, itemRows] = await Promise.all([
      this.db.select().from(racks).orderBy(asc(racks.name)),
      this.db.select({ rackId: rackItems.rackId, heightU: rackItems.heightU }).from(rackItems),
    ]);
    return rackRows.map((r) => {
      const mine = itemRows.filter((i) => i.rackId === r.id);
      return { ...toRack(r), itemCount: mine.length, usedUnits: usedUnits(mine) };
    });
  }

  private async rowById(id: string): Promise<RackRowDb> {
    const [row] = await this.db.select().from(racks).where(eq(racks.id, id)).limit(1);
    if (!row) throw new NotFoundException("Cabinet not found");
    return row;
  }

  async get(id: string): Promise<RackDetail> {
    const rack = await this.rowById(id);
    const items = (await this.db.select().from(rackItems).where(eq(rackItems.rackId, id))).map(toItem);
    return { ...toRack(rack), items: await this.withLive(items) };
  }

  async create(input: CreateRackInput): Promise<Rack> {
    await this.assertNameFree(input.name);
    const [row] = await this.db.insert(racks).values(input).returning();
    if (!row) throw new Error("cabinet insert failed");
    return toRack(row);
  }

  async update(id: string, input: UpdateRackInput): Promise<Rack> {
    const current = await this.rowById(id);
    if (input.name !== undefined) await this.assertNameFree(input.name, id);
    const newUnits = input.units;
    if (newUnits !== undefined && newUnits < current.units) {
      const items = await this.db.select({ id: rackItems.id, startU: rackItems.startU, heightU: rackItems.heightU, label: rackItems.label }).from(rackItems).where(eq(rackItems.rackId, id));
      const highest = Math.max(0, ...items.map(topU));
      if (highest > newUnits) {
        const over = items.filter((i) => topU(i) > newUnits).map((i) => i.label || "an item");
        throw new ConflictException(`Cannot make this cabinet ${newUnits}U: ${over.join(", ")} reach${over.length === 1 ? "es" : ""} U${highest}. Move or remove ${over.length === 1 ? "it" : "them"} first.`);
      }
    }
    const [row] = await this.db.update(racks).set({ ...input, updatedAt: new Date() }).where(eq(racks.id, id)).returning();
    if (!row) throw new NotFoundException("Cabinet not found");
    return toRack(row);
  }

  async remove(id: string): Promise<void> {
    await this.rowById(id);
    await this.db.delete(racks).where(eq(racks.id, id));
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const rows = await this.db.select({ id: racks.id, name: racks.name }).from(racks);
    if (rows.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException("A cabinet with that name already exists");
    }
  }

  // ---- items ----

  async addItem(rackId: string, input: CreateRackItemInput): Promise<RackItemView> {
    const rack = await this.rowById(rackId);
    if (input.modelId) await this.assertModel(input.modelId);

    const linked = input.sourceKind !== "custom";
    const sourceId = linked ? (input.sourceKind === "unifi" ? normaliseMac(input.sourceId ?? "") : (input.sourceId ?? "")) : null;
    let known: Known | null = null;
    if (linked && sourceId) {
      known = await this.lookup(input.sourceKind, sourceId);
      if (!known && input.sourceKind !== "unifi") throw new BadRequestException("That device no longer exists");
      // The controller may simply be unreachable: a UniFi device is then placed with the name the person gave.
      if (!known && !input.label) throw new BadRequestException("The UniFi controller could not be reached, so that device could not be checked. Try again in a moment.");
    }

    const created = await this.db.transaction(async (tx) => {
      // Writers to one cabinet take turns: the overlap check below reads every item, and two nodes placing at once must not both pass.
      await tx.update(racks).set({ updatedAt: new Date() }).where(eq(racks.id, rackId));
      const existing = (await tx.select().from(rackItems).where(eq(rackItems.rackId, rackId))).map(toItem);
      if (existing.length >= MAX_RACK_ITEMS) throw new ConflictException(`A cabinet holds at most ${MAX_RACK_ITEMS} items.`);
      const problem = placementProblem(rack.units, existing, { startU: input.startU, heightU: input.heightU });
      if (problem) throw new ConflictException(problem);
      if (linked && sourceId) {
        const [dup] = await tx.select({ id: rackItems.id, rackId: rackItems.rackId }).from(rackItems).where(eq(rackItems.sourceId, sourceId)).limit(1);
        if (dup) {
          const [where] = await tx.select({ name: racks.name }).from(racks).where(eq(racks.id, dup.rackId)).limit(1);
          throw new ConflictException(`That device is already in ${where?.name ?? "a cabinet"}.`);
        }
      }
      const [row] = await tx
        .insert(rackItems)
        .values({
          rackId,
          sourceKind: input.sourceKind,
          sourceId,
          label: linked ? (known?.name ?? input.label ?? "") : (input.label ?? ""),
          hostname: linked ? (known?.hostname ?? null) : (input.hostname || null),
          ip: linked ? (known?.ip ?? null) : (input.ip || null),
          style: input.style ?? known?.style ?? defaultRackStyle(input.sourceKind),
          startU: input.startU,
          heightU: input.heightU,
          modelId: input.modelId ?? null,
          notes: input.notes ?? "",
        })
        .returning();
      if (!row) throw new Error("cabinet item insert failed");
      return toItem(row);
    });
    return (await this.withLive([created]))[0]!;
  }

  async updateItem(rackId: string, itemId: string, input: UpdateRackItemInput): Promise<RackItemView> {
    const rack = await this.rowById(rackId);
    if (input.modelId) await this.assertModel(input.modelId);

    const updated = await this.db.transaction(async (tx) => {
      await tx.update(racks).set({ updatedAt: new Date() }).where(eq(racks.id, rackId));
      const existing = (await tx.select().from(rackItems).where(eq(rackItems.rackId, rackId))).map(toItem);
      const current = existing.find((i) => i.id === itemId);
      if (!current) throw new NotFoundException("Item not found in this cabinet");
      const place = { startU: input.startU ?? current.startU, heightU: input.heightU ?? current.heightU };
      const problem = placementProblem(rack.units, existing, place, itemId);
      if (problem) throw new ConflictException(problem);

      const set: Partial<typeof rackItems.$inferInsert> = { ...place, updatedAt: new Date() };
      if (input.style !== undefined) set.style = input.style;
      if (input.modelId !== undefined) set.modelId = input.modelId;
      if (input.notes !== undefined) set.notes = input.notes;
      // A linked item's name and address are the device's own; only a custom item has any to set.
      if (current.sourceKind === "custom") {
        if (input.label !== undefined) {
          if (!input.label) throw new BadRequestException("A name is required");
          set.label = input.label;
        }
        if (input.hostname !== undefined) set.hostname = input.hostname || null;
        if (input.ip !== undefined) set.ip = input.ip || null;
      }
      const [row] = await tx.update(rackItems).set(set).where(eq(rackItems.id, itemId)).returning();
      if (!row) throw new NotFoundException("Item not found in this cabinet");
      return toItem(row);
    });
    return (await this.withLive([updated]))[0]!;
  }

  async removeItem(rackId: string, itemId: string): Promise<void> {
    await this.rowById(rackId);
    const gone = await this.db
      .delete(rackItems)
      .where(and(eq(rackItems.id, itemId), eq(rackItems.rackId, rackId)))
      .returning({ id: rackItems.id });
    if (gone.length === 0) throw new NotFoundException("Item not found in this cabinet");
  }

  private async assertModel(id: string): Promise<void> {
    const [m] = await this.db.select({ id: switchModels.id, kind: switchModels.kind }).from(switchModels).where(eq(switchModels.id, id)).limit(1);
    if (!m || m.kind === "module") throw new BadRequestException("That picture set does not exist");
  }

  // ---- devices that could be placed ----

  async candidates(): Promise<RackCandidate[]> {
    const [switches, hosts, placed, unifiDevices] = await Promise.all([
      this.db.select().from(ciscoSwitches).orderBy(asc(ciscoSwitches.hostname)),
      this.db.select().from(infraTargets).orderBy(asc(infraTargets.name)),
      this.db
        .select({ sourceKind: rackItems.sourceKind, sourceId: rackItems.sourceId, rackId: rackItems.rackId, rackName: racks.name })
        .from(rackItems)
        .innerJoin(racks, eq(racks.id, rackItems.rackId)),
      this.unifiDevices().catch(() => [] as UDev[]),
    ]);
    const where = (kind: string, id: string) => {
      const hit = placed.find((p) => p.sourceKind === kind && p.sourceId === id);
      return hit ? { rackId: hit.rackId, rackName: hit.rackName } : null;
    };
    const out: RackCandidate[] = [];
    for (const s of switches) {
      out.push({ kind: "cisco", id: s.id, name: s.hostname, hostname: s.hostname, ip: s.ipAddress, model: s.model, style: "switch", placedIn: where("cisco", s.id) });
    }
    for (const h of hosts) {
      const k = this.infraKnown(h);
      out.push({ kind: "infra", id: h.id, name: k.name, hostname: k.hostname, ip: k.ip, model: null, style: "server", placedIn: where("infra", h.id) });
    }
    for (const d of unifiDevices) {
      if (!d.mac) continue;
      const mac = normaliseMac(d.mac);
      out.push({ kind: "unifi", id: mac, name: d.name?.trim() || mac, hostname: d.name?.trim() || null, ip: d.ip ?? null, model: d.model ?? null, style: unifiStyle(d.type), placedIn: where("unifi", mac) });
    }
    return out;
  }

  // ---- reading the devices ----

  private async unifiDevices(): Promise<UDev[]> {
    return this.cache.get("unifi-devices", UNIFI_READ_TTL_MS, async () => (await this.unifi.devices()) as UDev[], {
      failTtlMs: UNIFI_FAIL_TTL_MS,
      deadlineMs: UNIFI_DEADLINE_MS,
    });
  }

  private infraKnown(h: typeof infraTargets.$inferSelect): Known {
    const isIp = IPV4.test(h.host);
    return {
      name: h.name,
      hostname: isIp ? h.name : h.host === "local" ? h.name : h.host,
      ip: isIp ? h.host : null,
      model: null,
      status: h.status === "up" || h.status === "degraded" ? "up" : h.status === "down" ? "down" : "unknown",
      href: `/monitoring/infra/${h.id}`,
      style: "server",
      switchModelId: null,
      switchViewOff: false,
    };
  }

  private async lookup(kind: RackSourceKind, id: string): Promise<Known | null> {
    const map = await this.lookupMany(kind, [id]);
    return map.get(id) ?? null;
  }

  /** Devices of one kind by id. A kind that cannot be read right now (UniFi controller down) gives an empty map. */
  private async lookupMany(kind: RackSourceKind, ids: string[]): Promise<Map<string, Known>> {
    const out = new Map<string, Known>();
    if (ids.length === 0) return out;
    if (kind === "cisco") {
      const valid = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
      if (valid.length === 0) return out;
      for (const s of await this.db.select().from(ciscoSwitches).where(inArray(ciscoSwitches.id, valid))) {
        out.set(s.id, {
          name: s.hostname,
          hostname: s.hostname,
          ip: s.ipAddress,
          model: s.model,
          status: s.lastPolledAt === null ? "unknown" : s.reachable ? "up" : "down",
          href: `/monitoring/network-cisco/switches/${s.id}`,
          style: "switch",
          switchModelId: s.switchModelId,
          switchViewOff: s.switchViewOff,
        });
      }
    } else if (kind === "infra") {
      const valid = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
      if (valid.length === 0) return out;
      for (const h of await this.db.select().from(infraTargets).where(inArray(infraTargets.id, valid))) out.set(h.id, this.infraKnown(h));
    } else if (kind === "unifi") {
      let devices: UDev[];
      try {
        devices = await this.unifiDevices();
      } catch (err) {
        this.logger.debug(`UniFi devices unavailable for the cabinet: ${(err as Error).message}`);
        return out;
      }
      for (const d of devices) {
        if (!d.mac) continue;
        const mac = normaliseMac(d.mac);
        if (!ids.includes(mac)) continue;
        out.set(mac, {
          name: d.name?.trim() || mac,
          hostname: d.name?.trim() || null,
          ip: d.ip ?? null,
          model: d.model ?? null,
          status: d.state === 1 ? "up" : "down",
          href: "/monitoring/network",
          style: unifiStyle(d.type),
          switchModelId: null,
          switchViewOff: false,
        });
      }
    }
    return out;
  }

  /** Each item with what its device says now. A UniFi item whose controller cannot be read keeps what was stored and is not called missing. */
  private async withLive(items: RackItemRow[]): Promise<RackItemView[]> {
    const idsOf = (kind: RackSourceKind) => [...new Set(items.filter((i) => i.sourceKind === kind && i.sourceId).map((i) => i.sourceId as string))];
    const [cisco, infra, unifi] = await Promise.all([this.lookupMany("cisco", idsOf("cisco")), this.lookupMany("infra", idsOf("infra")), this.lookupMany("unifi", idsOf("unifi"))]);
    const unifiReadable = idsOf("unifi").length === 0 || unifi.size > 0 || (await this.unifiDevices().then(() => true, () => false));
    return items.map((item) => {
      if (item.sourceKind === "custom" || !item.sourceId) return { ...item, live: ownLive(item, false) };
      const source = item.sourceKind === "cisco" ? cisco : item.sourceKind === "infra" ? infra : unifi;
      const k = source.get(item.sourceId);
      if (!k) {
        // The controller being down is not the device being gone.
        const missing = item.sourceKind === "unifi" ? unifiReadable : true;
        return { ...item, live: ownLive(item, missing) };
      }
      return {
        ...item,
        live: {
          name: k.name,
          hostname: k.hostname,
          ip: k.ip,
          model: k.model,
          status: k.status,
          missing: false,
          href: k.href,
          switchModelId: k.switchModelId,
          switchViewOff: k.switchViewOff,
        },
      };
    });
  }
}
