import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  PERMISSIONS,
  type CreateLocationInput,
  type Location,
  type LocationRef,
  type LocationSummary,
  type LocationUsage,
  type UpdateLocationInput,
} from "@church/shared";
import { dbErrorCode } from "@church/shared/db";
import { DB, type Db } from "../db/db.module";
import { assetCheckouts, assets, infraTargets, locations, monitors, printers, racks, tickets } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { SearchService } from "../search/search.service";

type Row = typeof locations.$inferSelect;

/** How often the cabinets' old free-text locations are looked at for rooms to make (cheap, idempotent). */
const ADOPT_EVERY_MS = 6 * 60 * 60_000;

/** Ticket statuses that count as "open" on a room page. */
const OPEN_TICKET_STATUSES = ["open", "in_progress", "waiting"];

/** A room id given to another service must exist (null and undefined pass); for services that take the database directly. */
export async function checkLocation(db: Db, id: string | null | undefined): Promise<string | null | undefined> {
  if (!id) return id;
  const [r] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, id)).limit(1);
  if (!r) throw new BadRequestException("That room does not exist.");
  return id;
}

export function toLocation(r: Row): Location {
  return { id: r.id, name: r.name, building: r.building, notes: r.notes, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/**
 * Rooms (docs/assets.md): the list everyone reads, its edits (`locations:admin`), what a room holds, and the start-up job that
 * turns the cabinets' free-text location into rooms.
 */
@Injectable()
export class LocationsService implements OnModuleInit {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "locations-adopt", everyMs: ADOPT_EVERY_MS, initialDelayMs: 20_000, run: async () => void (await this.adoptRackLocations()) });
  }

  async list(): Promise<Location[]> {
    return (await this.db.select().from(locations).orderBy(asc(locations.building), asc(locations.name))).map(toLocation);
  }

  private async row(id: string): Promise<Row> {
    const [r] = await this.db.select().from(locations).where(eq(locations.id, id)).limit(1);
    if (!r) throw new NotFoundException("Room not found");
    return r;
  }

  async get(id: string): Promise<Location> {
    return toLocation(await this.row(id));
  }

  /** For the other services: a room id they were given must exist (null and undefined pass). */
  async check(id: string | null | undefined): Promise<void> {
    await checkLocation(this.db, id);
  }

  /** Names for a set of room ids. */
  async refs(ids: Iterable<string | null | undefined>): Promise<Map<string, LocationRef>> {
    const want = [...new Set([...ids].filter((x): x is string => !!x))];
    const out = new Map<string, LocationRef>();
    if (want.length === 0) return out;
    for (const r of await this.db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, want))) out.set(r.id, r);
    return out;
  }

  /** The room's name, or "" (what the cabinets' old text column is kept equal to). */
  async nameOf(id: string | null | undefined): Promise<string> {
    if (!id) return "";
    return (await this.refs([id])).get(id)?.name ?? "";
  }

  private duplicate(err: unknown, name: string): never {
    if (dbErrorCode(err) === "23505") throw new ConflictException(`There is already a room called ${name}.`);
    throw err;
  }

  async create(input: CreateLocationInput): Promise<Location> {
    try {
      const [r] = await this.db.insert(locations).values(input).returning();
      return toLocation(r!);
    } catch (err) {
      this.duplicate(err, input.name);
    }
  }

  async update(id: string, input: UpdateLocationInput): Promise<Location> {
    await this.row(id);
    try {
      const [r] = await this.db.update(locations).set({ ...input, updatedAt: new Date() }).where(eq(locations.id, id)).returning();
      // Cabinets keep the room's name in their old text column for older nodes.
      if (input.name !== undefined) {
        await this.db.update(racks).set({ location: input.name }).where(eq(racks.locationId, id));
        this.search.assetsChanged(); // equipment is found by its room's name
      }
      return toLocation(r!);
    } catch (err) {
      this.duplicate(err, input.name ?? "");
    }
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    // The foreign keys clear the links (ON DELETE SET NULL); the cabinets' text goes with them.
    await this.db.update(racks).set({ location: "" }).where(eq(racks.locationId, id));
    await this.db.delete(locations).where(eq(locations.id, id));
    this.search.assetsChanged();
  }

  async usage(id: string): Promise<LocationUsage> {
    await this.row(id);
    const n = async (table: typeof tickets | typeof assets | typeof racks | typeof monitors | typeof infraTargets | typeof printers) => {
      const [r] = await this.db.select({ n: count() }).from(table).where(eq(table.locationId, id));
      return Number(r?.n ?? 0);
    };
    return { tickets: await n(tickets), assets: await n(assets), racks: await n(racks), monitors: await n(monitors), hosts: await n(infraTargets), printers: await n(printers) };
  }

  /** The room page: only the sections the reader may see (docs/assets.md). */
  async summary(id: string, user: AuthenticatedUser): Promise<LocationSummary> {
    const location = toLocation(await this.row(id));
    const can = (p: string) => user.permissions.includes(p);
    const out: LocationSummary = { location };
    if (can(PERMISSIONS.ASSETS_READ_ANY)) {
      const rows = await this.db
        .select({ id: assets.id, tag: assets.tag, name: assets.name, status: assets.status, holderName: assetCheckouts.holderName })
        .from(assets)
        .leftJoin(assetCheckouts, and(eq(assetCheckouts.assetId, assets.id), isNull(assetCheckouts.returnedAt)))
        .where(eq(assets.locationId, id))
        .orderBy(asc(assets.name));
      out.assets = rows.map((r) => ({ ...r, holderName: r.holderName ?? null }));
    }
    if (can(PERMISSIONS.MONITORS_READ_ANY)) {
      out.racks = await this.db.select({ id: racks.id, name: racks.name }).from(racks).where(eq(racks.locationId, id)).orderBy(asc(racks.name));
      out.monitors = await this.db
        .select({ id: monitors.id, name: monitors.name, status: monitors.status })
        .from(monitors)
        .where(eq(monitors.locationId, id))
        .orderBy(asc(monitors.name));
      out.hosts = await this.db
        .select({ id: infraTargets.id, name: infraTargets.name, status: infraTargets.status })
        .from(infraTargets)
        .where(eq(infraTargets.locationId, id))
        .orderBy(asc(infraTargets.name));
    }
    if (can(PERMISSIONS.PRINTERS_READ_ANY)) {
      out.printers = await this.db.select({ id: printers.id, name: printers.name }).from(printers).where(eq(printers.locationId, id)).orderBy(asc(printers.name));
    }
    if (can(PERMISSIONS.TICKETS_READ_ANY) || can(PERMISSIONS.TICKETS_READ_OWN)) {
      const mine = can(PERMISSIONS.TICKETS_READ_ANY) ? undefined : eq(tickets.createdByUserId, user.id);
      out.tickets = await this.db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, status: tickets.status, priority: tickets.priority })
        .from(tickets)
        .where(and(eq(tickets.locationId, id), inArray(tickets.status, OPEN_TICKET_STATUSES), mine))
        .orderBy(desc(tickets.updatedAt))
        .limit(50);
    }
    return out;
  }

  /**
   * Turn each cabinet's free-text location into a room (one per distinct text, matched by name) and link it. Runs at start
   * and every few hours; once a cabinet has a room it is left alone, and clearing a cabinet's room clears its text too, so a
   * cleared one is not linked again.
   */
  async adoptRackLocations(): Promise<{ linked: number }> {
    const pending = await this.db
      .select({ id: racks.id, location: racks.location })
      .from(racks)
      .where(and(isNull(racks.locationId), ne(sql`trim(${racks.location})`, "")));
    let linked = 0;
    for (const name of [...new Set(pending.map((p) => p.location.trim()))]) {
      await this.db.insert(locations).values({ name }).onConflictDoNothing({ target: locations.name });
      const [room] = await this.db.select({ id: locations.id }).from(locations).where(eq(locations.name, name)).limit(1);
      if (!room) continue;
      const done = await this.db
        .update(racks)
        .set({ locationId: room.id, location: name })
        .where(and(isNull(racks.locationId), eq(sql`trim(${racks.location})`, name)))
        .returning({ id: racks.id });
      linked += done.length;
    }
    if (linked > 0) this.logger.log(`linked ${linked} cabinet(s) to rooms from their location text`);
    return { linked };
  }
}
