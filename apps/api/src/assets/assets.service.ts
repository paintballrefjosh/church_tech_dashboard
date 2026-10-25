import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  PERMISSIONS,
  assetOverdueDue,
  checkoutProblem,
  formatAssetTag,
  isOverdue,
  siteToday,
  type Asset,
  type AssetCategory,
  type AssetCheckout,
  type AssetListQuery,
  type AssetStatus,
  type CheckoutAssetInput,
  type CreateAssetInput,
  type ImportAssetsInput,
  type ImportAssetsResult,
  type ReturnAssetInput,
  type UpdateAssetInput,
} from "@church/shared";
import { dbErrorCode } from "@church/shared/db";
import { DB, type Db } from "../db/db.module";
import { assetCheckouts, assets, locations, tickets, users } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { SearchService } from "../search/search.service";
import { LocationsService } from "./locations.service";

type Row = typeof assets.$inferSelect;
type CheckoutRow = typeof assetCheckouts.$inferSelect;

const OVERDUE_EVERY_MS = 60 * 60_000;
/** Tries at a free `A-0000` tag before giving up (a restore or a hand-typed tag can be ahead of the sequence). */
const TAG_TRIES = 50;

const isStaff = (u: AuthenticatedUser) => u.permissions.includes(PERMISSIONS.ASSETS_WRITE_ANY);

/**
 * The asset inventory (docs/assets.md): items, check-out and return (one open check-out per item is the database's rule),
 * the hourly `asset-overdue` reminders, the tickets about an item, and import from a spreadsheet.
 */
@Injectable()
export class AssetsService implements OnModuleInit {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly rooms: LocationsService,
    private readonly notifications: NotificationsService,
    private readonly delivery: NotificationDeliveryService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "asset-overdue", everyMs: OVERDUE_EVERY_MS, initialDelayMs: 4 * 60_000, run: async () => void (await this.remindOverdueOnce()) });
  }

  private async today(): Promise<string> {
    return siteToday(new Date(), await this.delivery.zone());
  }

  private async names(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const want = [...new Set([...ids].filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    if (want.length === 0) return out;
    for (const u of await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, want))) {
      out.set(u.id, u.name ?? u.email);
    }
    return out;
  }

  /** Items as the reader may see them: cost and purchase date only for staff. */
  private async toDto(rows: Row[], user: AuthenticatedUser): Promise<Asset[]> {
    if (rows.length === 0) return [];
    const open = await this.db
      .select()
      .from(assetCheckouts)
      .where(and(inArray(assetCheckouts.assetId, rows.map((r) => r.id)), isNull(assetCheckouts.returnedAt)));
    const byAsset = new Map(open.map((c) => [c.assetId, c]));
    const rooms = await this.rooms.refs(rows.map((r) => r.locationId));
    const staff = isStaff(user);
    const today = await this.today();
    return rows.map((r) => {
      const co = byAsset.get(r.id);
      return {
        id: r.id,
        tag: r.tag,
        name: r.name,
        category: r.category as AssetCategory,
        make: r.make,
        model: r.model,
        serial: r.serial,
        location: r.locationId ? (rooms.get(r.locationId) ?? null) : null,
        status: r.status as AssetStatus,
        lendable: r.lendable,
        purchasedOn: staff ? r.purchasedOn : null,
        cost: staff ? r.cost : null,
        warrantyUntil: r.warrantyUntil,
        notes: r.notes,
        holder: co
          ? { checkoutId: co.id, userId: co.holderUserId, name: co.holderName, outAt: co.outAt.toISOString(), dueOn: co.dueOn, overdue: isOverdue(co.dueOn, today) }
          : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  async list(query: AssetListQuery, user: AuthenticatedUser): Promise<Asset[]> {
    const where: SQL[] = [];
    if (query.category) where.push(eq(assets.category, query.category));
    if (query.status) where.push(eq(assets.status, query.status));
    if (query.locationId) where.push(eq(assets.locationId, query.locationId));
    if (query.q?.trim()) {
      const like = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(or(ilike(assets.tag, like), ilike(assets.name, like), ilike(assets.serial, like), ilike(assets.make, like), ilike(assets.model, like))!);
    }
    if (query.holding) {
      const open = and(eq(assetCheckouts.assetId, assets.id), isNull(assetCheckouts.returnedAt));
      const extra =
        query.holding === "mine"
          ? eq(assetCheckouts.holderUserId, user.id)
          : query.holding === "overdue"
            ? and(isNotNull(assetCheckouts.dueOn), lt(assetCheckouts.dueOn, await this.today()))
            : undefined;
      where.push(sql`exists (select 1 from ${assetCheckouts} where ${and(open, extra)})`);
    }
    const rows = await this.db
      .select()
      .from(assets)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(assets.name), asc(assets.tag));
    return this.toDto(rows, user);
  }

  private async row(id: string): Promise<Row> {
    const [r] = await this.db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!r) throw new NotFoundException("Item not found");
    return r;
  }

  async get(id: string, user: AuthenticatedUser): Promise<Asset> {
    return (await this.toDto([await this.row(id)], user))[0]!;
  }

  /** The next free `A-0000` tag. */
  private async nextTag(tx: Pick<Db, "execute" | "select"> = this.db): Promise<string> {
    for (let i = 0; i < TAG_TRIES; i++) {
      const res = await tx.execute(sql`SELECT nextval('assets_tag_seq') AS n`);
      const tag = formatAssetTag(Number((res.rows[0] as { n: unknown }).n));
      const [taken] = await tx.select({ id: assets.id }).from(assets).where(eq(assets.tag, tag)).limit(1);
      if (!taken) return tag;
    }
    throw new ConflictException("Could not find a free tag; type one.");
  }

  private duplicateTag(err: unknown, tag: string): never {
    if (dbErrorCode(err) === "23505") throw new ConflictException(`Another item already has the tag ${tag}.`);
    throw err;
  }

  async create(input: CreateAssetInput, user: AuthenticatedUser): Promise<Asset> {
    await this.rooms.check(input.locationId);
    const tag = input.tag?.trim() || (await this.nextTag());
    try {
      const [r] = await this.db.insert(assets).values({ ...input, tag }).returning();
      this.search.assetsChanged();
      return (await this.toDto([r!], user))[0]!;
    } catch (err) {
      this.duplicateTag(err, tag);
    }
  }

  async update(id: string, input: UpdateAssetInput, user: AuthenticatedUser): Promise<Asset> {
    await this.row(id);
    await this.rooms.check(input.locationId);
    try {
      const [r] = await this.db.update(assets).set({ ...input, updatedAt: new Date() }).where(eq(assets.id, id)).returning();
      this.search.assetsChanged();
      return (await this.toDto([r!], user))[0]!;
    } catch (err) {
      this.duplicateTag(err, input.tag ?? "");
    }
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.db.delete(assets).where(eq(assets.id, id));
    this.search.assetsChanged();
  }

  /**
   * Check an item out. To yourself with `assets:checkout:own`; to another account or a typed name with `assets:write:any`.
   * The partial unique index makes a second open check-out impossible, so two people at the same label cannot both win.
   */
  async checkout(id: string, input: CheckoutAssetInput, user: AuthenticatedUser): Promise<Asset> {
    const forSomeoneElse = (input.holderUserId && input.holderUserId !== user.id) || !!input.holderName;
    if (forSomeoneElse && !isStaff(user)) throw new ForbiddenException("Only staff can check an item out to someone else.");
    if (!forSomeoneElse && !user.permissions.includes(PERMISSIONS.ASSETS_CHECKOUT_OWN)) throw new ForbiddenException("You cannot check items out.");
    const asset = await this.get(id, user);
    const problem = checkoutProblem(asset);
    if (problem) throw new ConflictException(problem);
    let holderUserId: string | null = user.id;
    let holderName = user.name ?? user.email;
    if (input.holderName) {
      holderUserId = null;
      holderName = input.holderName;
    } else if (input.holderUserId && input.holderUserId !== user.id) {
      const [h] = await this.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.id, input.holderUserId), isNull(users.deletedAt)))
        .limit(1);
      if (!h) throw new BadRequestException("That person does not exist.");
      holderUserId = h.id;
      holderName = h.name ?? h.email;
    }
    try {
      await this.db.insert(assetCheckouts).values({ assetId: id, holderUserId, holderName, outByUserId: user.id, dueOn: input.dueOn, note: input.note });
    } catch (err) {
      if (dbErrorCode(err) === "23505") {
        const now = await this.get(id, user);
        throw new ConflictException(now.holder ? `It was just checked out to ${now.holder.name}.` : "It was just checked out.");
      }
      throw err;
    }
    return this.get(id, user);
  }

  /** Bring an item back: its holder, or staff. A conditional UPDATE, so a double press returns it once. */
  async returnAsset(id: string, input: ReturnAssetInput, user: AuthenticatedUser): Promise<Asset> {
    const asset = await this.get(id, user);
    if (!asset.holder) throw new ConflictException("It is not checked out.");
    if (asset.holder.userId !== user.id && !isStaff(user)) throw new ForbiddenException(`It is checked out to ${asset.holder.name}; only they or staff can return it.`);
    await this.db
      .update(assetCheckouts)
      .set({ returnedAt: new Date(), returnedByUserId: user.id, returnNote: input.note })
      .where(and(eq(assetCheckouts.id, asset.holder.checkoutId), isNull(assetCheckouts.returnedAt)));
    return this.get(id, user);
  }

  /** Change the due date of the open check-out (staff). A new date starts its reminder again. */
  async setDue(id: string, dueOn: string | null, user: AuthenticatedUser): Promise<Asset> {
    const asset = await this.get(id, user);
    if (!asset.holder) throw new ConflictException("It is not checked out.");
    await this.db.update(assetCheckouts).set({ dueOn }).where(and(eq(assetCheckouts.id, asset.holder.checkoutId), isNull(assetCheckouts.returnedAt)));
    return this.get(id, user);
  }

  /** Who has had it (staff only: the route checks). */
  async history(id: string): Promise<AssetCheckout[]> {
    await this.row(id);
    const rows = await this.db.select().from(assetCheckouts).where(eq(assetCheckouts.assetId, id)).orderBy(desc(assetCheckouts.outAt)).limit(200);
    const names = await this.names(rows.flatMap((r) => [r.outByUserId, r.returnedByUserId]));
    return rows.map((r) => ({
      id: r.id,
      holderUserId: r.holderUserId,
      holderName: r.holderName,
      outByName: r.outByUserId ? (names.get(r.outByUserId) ?? null) : null,
      outAt: r.outAt.toISOString(),
      dueOn: r.dueOn,
      returnedAt: r.returnedAt ? r.returnedAt.toISOString() : null,
      returnedByName: r.returnedByUserId ? (names.get(r.returnedByUserId) ?? null) : null,
      note: r.note,
      returnNote: r.returnNote,
    }));
  }

  /** Tickets about the item that the reader can read (their own, or all with `tickets:read:any`). */
  async tickets(id: string, user: AuthenticatedUser) {
    await this.row(id);
    const any = user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY);
    if (!any && !user.permissions.includes(PERMISSIONS.TICKETS_READ_OWN)) return [];
    return this.db
      .select({ id: tickets.id, number: tickets.number, title: tickets.title, status: tickets.status, priority: tickets.priority, updatedAt: tickets.updatedAt })
      .from(tickets)
      .where(and(eq(tickets.assetId, id), any ? undefined : eq(tickets.createdByUserId, user.id)))
      .orderBy(desc(tickets.updatedAt))
      .limit(50)
      .then((rows) => rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })));
  }

  /**
   * Many items at once, all or nothing. Rooms are matched by name (any case); a missing one is created when `createRooms`
   * is set, otherwise the import is refused naming it. A tag already in use is refused with its row.
   */
  async import(input: ImportAssetsInput): Promise<ImportAssetsResult> {
    const result = await this.db.transaction(async (tx) => {
      const known = new Map<string, string>();
      for (const l of await tx.select({ id: locations.id, name: locations.name }).from(locations)) known.set(l.name.toLowerCase(), l.id);
      const missing = [...new Set(input.rows.map((r) => r.room.trim()).filter((n) => n && !known.has(n.toLowerCase())))];
      if (missing.length > 0 && !input.createRooms) {
        throw new BadRequestException(`These rooms do not exist: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " ..." : ""}. Add them, or tick "create missing rooms".`);
      }
      const roomsCreated: string[] = [];
      for (const name of missing) {
        const [r] = await tx.insert(locations).values({ name }).returning({ id: locations.id });
        known.set(name.toLowerCase(), r!.id);
        roomsCreated.push(name);
      }
      const tags = input.rows.map((r) => r.tag?.trim()).filter((t): t is string => !!t);
      if (tags.length > 0) {
        const taken = await tx.select({ tag: assets.tag }).from(assets).where(inArray(assets.tag, tags));
        if (taken.length > 0) {
          const row = input.rows.findIndex((r) => r.tag?.trim() === taken[0]!.tag) + 1;
          throw new ConflictException(`Item ${row} has the tag ${taken[0]!.tag}, which another item already has.`);
        }
      }
      for (const r of input.rows) {
        const { room, tag, ...rest } = r;
        await tx.insert(assets).values({
          ...rest,
          locationId: room.trim() ? (known.get(room.trim().toLowerCase()) ?? null) : null,
          tag: tag?.trim() || (await this.nextTag(tx)),
        });
      }
      return { created: input.rows.length, roomsCreated };
    });
    this.search.assetsChanged();
    return result;
  }

  /** The `asset-overdue` job: one notice per due date to the holder and whoever checked it out, each CLAIMED first. */
  async remindOverdueOnce(): Promise<{ sent: number }> {
    const today = await this.today();
    const open: CheckoutRow[] = await this.db
      .select()
      .from(assetCheckouts)
      .where(and(isNull(assetCheckouts.returnedAt), isNotNull(assetCheckouts.dueOn), lt(assetCheckouts.dueOn, today)));
    let sent = 0;
    for (const co of open) {
      const due = assetOverdueDue(co, today);
      if (!due) continue;
      const claimed = await this.db
        .update(assetCheckouts)
        .set({ remindedFor: co.dueOn })
        .where(and(eq(assetCheckouts.id, co.id), isNull(assetCheckouts.returnedAt), or(isNull(assetCheckouts.remindedFor), sql`${assetCheckouts.remindedFor} <> ${co.dueOn}`)))
        .returning({ id: assetCheckouts.id });
      if (claimed.length === 0 || due === "silent") continue;
      const [a] = await this.db.select({ tag: assets.tag, name: assets.name }).from(assets).where(eq(assets.id, co.assetId)).limit(1);
      if (!a) continue;
      const to = [...new Set([co.holderUserId, co.outByUserId].filter((x): x is string => !!x))];
      await this.notifications.createMany(
        to.map((recipientUserId) => ({
          recipientUserId,
          kind: "asset.overdue",
          title: `${a.name} (${a.tag}) was due back on ${co.dueOn}`,
          body: recipientUserId === co.holderUserId ? "It is checked out to you. Return it, or ask staff for a new date." : `It is checked out to ${co.holderName}.`,
          link: `/assets/${co.assetId}`,
        })),
      );
      sent++;
    }
    if (sent > 0) this.logger.log(`overdue equipment reminders sent: ${sent}`);
    return { sent };
  }
}
