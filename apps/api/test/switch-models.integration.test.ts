import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/node-postgres";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { SwitchModelsService } from "../src/switch-models/switch-models.service";
import { CiscoService } from "../src/cisco/cisco.service";
import type { AttachmentsService } from "../src/attachments/attachments.service";
import * as schema from "../src/db/schema";

/**
 * Switch models against a real database (see db-stores.integration.test.ts for the setup): names, ports as stored JSON,
 * a picture's replace and remove, and what the foreign key to `attachments` does. The attachment store is a stand-in that
 * writes real `attachments` rows (the foreign key needs them) and keeps the bytes in memory, so no object store is needed.
 * It empties `switch_models` and its own attachments, so never point it at a database you care about. Run on CockroachDB
 * and YugabyteDB.
 */
const url = process.env.TEST_DATABASE_URL;

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const port = (name: string, over: Record<string, unknown> = {}) => ({ name, aliases: [], kind: "rj45" as const, x: 0.1, y: 0.2, w: 0.02, h: 0.3, ...over });

describe.skipIf(!url)("switch models against a real database", () => {
  let pool: Pool;
  let svc: SwitchModelsService;
  const bytes = new Map<string, Buffer>();
  const removedParents: string[] = [];
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 4 });
    const db = drizzle(pool, { schema });
    // Just the parts of AttachmentsService the model uses.
    const fake = {
      async upload(parentType: string, parentId: string, _user: string, file: { filename: string; mimetype: string; stream: Readable }) {
        const chunks: Buffer[] = [];
        for await (const c of file.stream) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        const [row] = await db
          .insert(schema.attachments)
          .values({ parentType, parentId, filename: file.filename, contentType: file.mimetype, sizeBytes: buf.length, storageKey: `test/${crypto.randomUUID()}` })
          .returning();
        bytes.set(row!.id, buf);
        return { id: row!.id };
      },
      async delete(_parentType: string, _parentId: string, id: string) {
        await q("DELETE FROM attachments WHERE id = $1", [id]);
        bytes.delete(id);
      },
      async deleteAllForParent(parentType: string, parentId: string) {
        removedParents.push(`${parentType}:${parentId}`);
        await q("DELETE FROM attachments WHERE parent_type = $1 AND parent_id = $2", [parentType, parentId]);
      },
      async getOne(_pt: string, _pid: string, id: string) {
        const r = await q("SELECT content_type, filename, storage_key FROM attachments WHERE id = $1", [id]);
        return { row: { contentType: r.rows[0].content_type, filename: r.rows[0].filename }, storageKey: id };
      },
      async openStream(key: string) {
        return Readable.from([bytes.get(key)!]);
      },
    };
    svc = new SwitchModelsService(db as never, fake as unknown as AttachmentsService);
  });

  beforeEach(async () => {
    removedParents.length = 0;
    await q("DELETE FROM switch_models");
    await q("DELETE FROM attachments WHERE parent_type = 'switch_model'");
  });

  afterAll(async () => {
    await q("DELETE FROM switch_models");
    await q("DELETE FROM attachments WHERE parent_type = 'switch_model'");
    await pool.end();
  });

  const attachmentCount = async () => Number((await q("SELECT count(*) AS n FROM attachments WHERE parent_type = 'switch_model'")).rows[0].n);

  it("creates a model and lists it with its defaults", async () => {
    const m = await svc.create({ name: "Catalyst 3850", match: ["C3850"], portSide: "front" });
    expect(m).toMatchObject({ name: "Catalyst 3850", match: ["C3850"], portSide: "front", ports: [], frontImageId: null, backImageId: null });
    expect((await svc.list()).map((x) => x.id)).toEqual([m.id]);
    expect(await svc.get(m.id)).toMatchObject({ name: "Catalyst 3850" });
  });

  it("refuses a second model with the same name, in any case", async () => {
    await svc.create({ name: "Nexus 3064", match: [], portSide: "front" });
    await expect(svc.create({ name: "nexus 3064", match: [], portSide: "back" })).rejects.toBeInstanceOf(ConflictException);
    const other = await svc.create({ name: "Other", match: [], portSide: "front" });
    await expect(svc.update(other.id, { name: "NEXUS 3064" })).rejects.toBeInstanceOf(ConflictException);
    // renaming to its own name (a different case) is fine
    await expect(svc.update(other.id, { name: "OTHER" })).resolves.toMatchObject({ name: "OTHER" });
  });

  it("stores the port layout and gives it back exactly", async () => {
    const m = await svc.create({ name: "M", match: [], portSide: "front" });
    const ports = [port("Gi1/0/1"), port("Gi1/1/1", { kind: "sfp", aliases: ["Te1/1/1"], x: 0.8 })];
    const saved = await svc.update(m.id, { ports, portSide: "back", match: ["C3850-48"] });
    expect(saved.ports).toEqual(ports);
    expect(saved).toMatchObject({ portSide: "back", match: ["C3850-48"] });
    expect(new Date(saved.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(m.updatedAt).getTime());
    expect((await svc.get(m.id)).ports).toEqual(ports);
  });

  it("shows no ports, rather than failing the list, when the stored layout cannot be read", async () => {
    const m = await svc.create({ name: "Broken", match: [], portSide: "front" });
    await q("UPDATE switch_models SET ports = '[{\"name\": 5}]'::jsonb WHERE id = $1", [m.id]);
    const [row] = await svc.list();
    expect(row!.ports).toEqual([]);
  });

  it("reports a missing model", async () => {
    await expect(svc.get("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.update("00000000-0000-4000-8000-000000000000", { name: "x" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("takes a picture, reads its size, and replaces it without leaving the old one behind", async () => {
    const m = await svc.create({ name: "Pics", match: [], portSide: "front" });
    const a = await svc.setImage(m.id, "front", "u", { filename: "a.png", mimetype: "image/png", bytes: png(2000, 200) });
    expect(a).toMatchObject({ frontWidth: 2000, frontHeight: 200, backImageId: null });
    expect(a.frontImageId).toBeTruthy();
    expect(await attachmentCount()).toBe(1);

    const b = await svc.setImage(m.id, "front", "u", { filename: "b.png", mimetype: "image/png", bytes: png(1800, 190) });
    expect(b.frontImageId).not.toBe(a.frontImageId);
    expect(b).toMatchObject({ frontWidth: 1800, frontHeight: 190 });
    expect(await attachmentCount()).toBe(1);

    await svc.setImage(m.id, "back", "u", { filename: "c.png", mimetype: "image/png", bytes: png(1000, 100) });
    expect(await attachmentCount()).toBe(2);

    const img = await svc.openImage(m.id, "front");
    expect(img.contentType).toBe("image/png");
    expect(img.attachmentId).toBe(b.frontImageId);
    await expect(svc.openImage(m.id, "front").then(async (i) => (await streamToBuffer(i.stream)).length)).resolves.toBe(33);
  });

  it("judges a picture on its own bytes, whatever the browser said", async () => {
    const m = await svc.create({ name: "Bytes", match: [], portSide: "front" });
    await expect(svc.setImage(m.id, "front", "u", { filename: "x.png", mimetype: "image/png", bytes: Buffer.from("<svg onload=alert(1)>") })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setImage(m.id, "front", "u", { filename: "x.png", mimetype: "image/png", bytes: Buffer.from("GIF89a" + "\0".repeat(40), "latin1") })).rejects.toBeInstanceOf(BadRequestException);
    expect(await attachmentCount()).toBe(0);
  });

  it("removes a picture and its attachment, and a side with none is left alone", async () => {
    const m = await svc.create({ name: "Rm", match: [], portSide: "front" });
    await svc.setImage(m.id, "back", "u", { filename: "c.png", mimetype: "image/png", bytes: png(1000, 100) });
    const gone = await svc.removeImage(m.id, "back");
    expect(gone).toMatchObject({ backImageId: null, backWidth: null, backHeight: null });
    expect(await attachmentCount()).toBe(0);
    await expect(svc.removeImage(m.id, "front")).resolves.toMatchObject({ frontImageId: null });
    await expect(svc.openImage(m.id, "back")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clears the picture, not the model, if its attachment row goes (a restore of part of the data)", async () => {
    const m = await svc.create({ name: "Fk", match: [], portSide: "front" });
    const withPic = await svc.setImage(m.id, "front", "u", { filename: "a.png", mimetype: "image/png", bytes: png(2000, 200) });
    await q("DELETE FROM attachments WHERE id = $1", [withPic.frontImageId]);
    const after = await svc.get(m.id);
    expect(after.frontImageId).toBeNull();
    expect(after.name).toBe("Fk");
  });

  it("deletes the model together with its pictures", async () => {
    const m = await svc.create({ name: "Del", match: [], portSide: "front" });
    await svc.setImage(m.id, "front", "u", { filename: "a.png", mimetype: "image/png", bytes: png(2000, 200) });
    await svc.remove(m.id);
    expect(await svc.list()).toEqual([]);
    expect(await attachmentCount()).toBe(0);
    expect(removedParents).toEqual([`switch_model:${m.id}`]);
    await expect(svc.remove(m.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("which model draws a switch (migration 0071)", () => {
    let cisco: CiscoService;
    const HOST = "swview-test-switch";

    beforeAll(() => {
      // setSwitchView and getById never touch the VLAN service.
      cisco = new CiscoService(drizzle(pool, { schema }) as never, {} as never);
    });
    beforeEach(async () => {
      await q("DELETE FROM cisco_switches WHERE hostname = $1", [HOST]);
    });
    afterAll(async () => {
      await q("DELETE FROM cisco_switches WHERE hostname = $1", [HOST]);
    });

    async function newSwitch(): Promise<string> {
      const r = await q("INSERT INTO cisco_switches (hostname, ip_address, username, model) VALUES ($1, '192.0.2.10', 'u', 'N3K-C3064PQ-10GX') RETURNING id", [HOST]);
      return r.rows[0].id as string;
    }

    it("starts as automatic, and saves a pick, 'off' and back to automatic", async () => {
      const sw = await newSwitch();
      const m = await svc.create({ name: "Pick me", match: [], portSide: "front" });
      expect(await cisco.getById(sw)).toMatchObject({ switchModelId: null, switchViewOff: false });

      expect(await cisco.setSwitchView(sw, { mode: "model", modelId: m.id })).toMatchObject({ switchModelId: m.id, switchViewOff: false });
      expect(await cisco.setSwitchView(sw, { mode: "off" })).toMatchObject({ switchModelId: null, switchViewOff: true });
      expect(await cisco.setSwitchView(sw, { mode: "auto" })).toMatchObject({ switchModelId: null, switchViewOff: false });
      // the same answer on a fresh read
      expect(await cisco.getById(sw)).toMatchObject({ switchModelId: null, switchViewOff: false });
    });

    it("refuses a model that does not exist and a switch that does not exist", async () => {
      const sw = await newSwitch();
      await expect(cisco.setSwitchView(sw, { mode: "model", modelId: "11111111-1111-4111-8111-111111111111" })).rejects.toBeInstanceOf(BadRequestException);
      await expect(cisco.setSwitchView("22222222-2222-4222-8222-222222222222", { mode: "auto" })).rejects.toBeInstanceOf(NotFoundException);
      expect(await cisco.getById(sw)).toMatchObject({ switchModelId: null });
    });

    it("goes back to automatic, keeping the switch, when its model is deleted", async () => {
      const sw = await newSwitch();
      const m = await svc.create({ name: "Soon gone", match: [], portSide: "front" });
      await cisco.setSwitchView(sw, { mode: "model", modelId: m.id });
      await svc.remove(m.id);
      expect(await cisco.getById(sw)).toMatchObject({ hostname: HOST, switchModelId: null, switchViewOff: false });
    });
  });
});

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
