import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import {
  switchModelPortsSchema,
  switchModelModulesSchema,
  switchModelMatchSchema,
  SWITCH_MODEL_IMAGE_TYPES,
  type CreateSwitchModelInput,
  type SwitchModel,
  type SwitchModelModule,
  type SwitchModelSide,
  type UpdateSwitchModelInput,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { switchModels } from "../db/schema";
import { AttachmentsService } from "../attachments/attachments.service";
import { imageSize } from "./image-size";

type Row = typeof switchModels.$inferSelect;

/** Smaller than the general attachment cap on purpose: these are catalogue pictures that every page load may fetch. */
export const MAX_SWITCH_IMAGE_BYTES = 8 * 1024 * 1024;

function toModel(r: Row): SwitchModel {
  const ports = switchModelPortsSchema.safeParse(r.ports);
  const match = switchModelMatchSchema.safeParse(r.match);
  const modules = switchModelModulesSchema.safeParse(r.modules);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === "module" ? "module" : "switch",
    match: match.success ? match.data : [],
    portSide: r.portSide === "back" ? "back" : "front",
    frontImageId: r.frontImageId,
    backImageId: r.backImageId,
    frontWidth: r.frontWidth,
    frontHeight: r.frontHeight,
    backWidth: r.backWidth,
    backHeight: r.backHeight,
    // A row whose ports no longer parse (edited in SQL) shows no ports rather than failing the whole list.
    ports: ports.success ? ports.data : [],
    modules: modules.success ? modules.data : [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

@Injectable()
export class SwitchModelsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly attachments: AttachmentsService,
  ) {}

  async list(): Promise<SwitchModel[]> {
    const rows = await this.db.select().from(switchModels);
    return rows.map(toModel).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<SwitchModel> {
    const [row] = await this.db.select().from(switchModels).where(eq(switchModels.id, id)).limit(1);
    if (!row) throw new NotFoundException("Switch model not found");
    return toModel(row);
  }

  async create(input: CreateSwitchModelInput): Promise<SwitchModel> {
    await this.assertNameFree(input.name);
    const [row] = await this.db
      .insert(switchModels)
      // A module is never matched to a device, so it keeps no match strings.
      .values({ name: input.name, kind: input.kind, match: input.kind === "module" ? [] : input.match, portSide: input.portSide })
      .returning();
    if (!row) throw new Error("switch model insert failed");
    return toModel(row);
  }

  async update(id: string, input: UpdateSwitchModelInput): Promise<SwitchModel> {
    const current = await this.get(id);
    if (input.name !== undefined) await this.assertNameFree(input.name, id);
    if (input.modules !== undefined) await this.assertModules(current, input.modules);
    const set: Partial<typeof switchModels.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.match !== undefined) set.match = input.match;
    if (input.portSide !== undefined) set.portSide = input.portSide;
    if (input.ports !== undefined) set.ports = input.ports;
    if (input.modules !== undefined) set.modules = input.modules;
    const [row] = await this.db.update(switchModels).set(set).where(eq(switchModels.id, id)).returning();
    if (!row) throw new NotFoundException("Switch model not found");
    return toModel(row);
  }

  /** Removes the model and its pictures. */
  async remove(id: string): Promise<void> {
    const model = await this.get(id);
    if (model.kind === "module") {
      const users = (await this.list()).filter((m) => m.modules.some((p) => p.moduleId === id));
      if (users.length > 0) {
        throw new ConflictException(`${model.name} is placed on ${users.map((u) => u.name).join(", ")}. Remove it from there first.`);
      }
    }
    await this.db.delete(switchModels).where(eq(switchModels.id, id));
    await this.attachments.deleteAllForParent("switch_model", id);
  }

  /**
   * Replaces one side's picture. The file is judged on its own bytes (a PNG, JPEG or WebP whose size can be read) and
   * stored through the attachment store; the old picture goes only once the new one is in place.
   */
  async setImage(id: string, side: SwitchModelSide, userId: string, file: { filename: string; mimetype: string; bytes: Buffer }): Promise<SwitchModel> {
    const model = await this.get(id);
    const size = imageSize(file.bytes);
    if (!size) throw new BadRequestException("The picture must be a PNG, JPEG or WebP file.");
    if (!(SWITCH_MODEL_IMAGE_TYPES as readonly string[]).includes(size.type)) throw new BadRequestException("Unsupported picture type.");
    if (file.bytes.length > MAX_SWITCH_IMAGE_BYTES) {
      throw new BadRequestException(`The picture is larger than ${MAX_SWITCH_IMAGE_BYTES / (1024 * 1024)} MiB. Save it smaller (about 2000 px wide is plenty).`);
    }
    // The type is the file's own, not the browser's claim.
    const stored = await this.attachments.upload("switch_model", id, userId, {
      filename: file.filename,
      mimetype: size.type,
      stream: Readable.from([file.bytes]),
      sizeLimit: 0,
    });
    const old = side === "front" ? model.frontImageId : model.backImageId;
    const set: Partial<typeof switchModels.$inferInsert> =
      side === "front"
        ? { frontImageId: stored.id, frontWidth: size.width, frontHeight: size.height, updatedAt: new Date() }
        : { backImageId: stored.id, backWidth: size.width, backHeight: size.height, updatedAt: new Date() };
    const [row] = await this.db.update(switchModels).set(set).where(eq(switchModels.id, id)).returning();
    if (!row) throw new NotFoundException("Switch model not found");
    if (old) await this.attachments.delete("switch_model", id, old).catch(() => undefined);
    return toModel(row);
  }

  async removeImage(id: string, side: SwitchModelSide): Promise<SwitchModel> {
    const model = await this.get(id);
    const old = side === "front" ? model.frontImageId : model.backImageId;
    if (!old) return model;
    const set: Partial<typeof switchModels.$inferInsert> =
      side === "front"
        ? { frontImageId: null, frontWidth: null, frontHeight: null, updatedAt: new Date() }
        : { backImageId: null, backWidth: null, backHeight: null, updatedAt: new Date() };
    const [row] = await this.db.update(switchModels).set(set).where(eq(switchModels.id, id)).returning();
    if (!row) throw new NotFoundException("Switch model not found");
    await this.attachments.delete("switch_model", id, old).catch(() => undefined);
    return toModel(row);
  }

  async openImage(id: string, side: SwitchModelSide): Promise<{ stream: Readable; contentType: string; filename: string; attachmentId: string }> {
    const model = await this.get(id);
    const attachmentId = side === "front" ? model.frontImageId : model.backImageId;
    if (!attachmentId) throw new NotFoundException("No picture on that side");
    const { row, storageKey } = await this.attachments.getOne("switch_model", id, attachmentId);
    const stream = await this.attachments.openStream(storageKey);
    return { stream, contentType: row.contentType, filename: row.filename, attachmentId };
  }

  /** Only a switch holds modules, and each placement must point at a model that is a module. */
  private async assertModules(host: SwitchModel, modules: SwitchModelModule[]): Promise<void> {
    if (modules.length === 0) return;
    if (host.kind !== "switch") throw new BadRequestException("A module cannot hold other modules.");
    const known = new Map((await this.list()).map((m) => [m.id, m]));
    for (const p of modules) {
      const m = known.get(p.moduleId);
      if (!m || m.kind !== "module") throw new BadRequestException("A placed module must be an add-on module that exists.");
    }
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const rows = await this.db.select({ id: switchModels.id, name: switchModels.name }).from(switchModels);
    const clash = rows.find((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new ConflictException(`A switch model called "${clash.name}" already exists.`);
  }
}
