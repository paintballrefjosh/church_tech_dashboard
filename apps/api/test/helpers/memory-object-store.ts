import { Readable } from "node:stream";
import type { ObjectInfo, ObjectStore } from "../../src/backup/object-store";

/** An object store in memory, for tests of the backup code. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  async stat(key: string): Promise<{ size: number } | null> {
    const o = this.objects.get(key);
    return o ? { size: o.data.length } : null;
  }

  async get(key: string): Promise<Readable> {
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
    return Readable.from([o.data]);
  }

  async put(key: string, body: Readable | Buffer, contentType: string): Promise<void> {
    if (Buffer.isBuffer(body)) {
      this.objects.set(key, { data: body, contentType });
      return;
    }
    const parts: Buffer[] = [];
    for await (const chunk of body) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    this.objects.set(key, { data: Buffer.concat(parts), contentType });
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.data.length }));
  }
}
