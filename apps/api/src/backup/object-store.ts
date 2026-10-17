import type { Readable } from "node:stream";
import type { Client } from "minio";
import { getS3 } from "../attachments/s3.client";

/**
 * The few object-store calls a backup needs. The real one talks to the app's S3 bucket;
 * tests use an in-memory one (apps/api/test/helpers/memory-object-store.ts).
 */
export interface ObjectInfo {
  key: string;
  size: number;
  /** Epoch milliseconds, when the store says. */
  lastModified?: number;
}

export interface ObjectStore {
  stat(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<Readable>;
  put(key: string, body: Readable | Buffer, contentType: string, size?: number): Promise<void>;
  remove(keys: string[]): Promise<void>;
  list(prefix: string): Promise<ObjectInfo[]>;
}

export const OBJECT_STORE = Symbol("OBJECT_STORE");

/** Where backup archives live in the bucket (next to, not among, the uploaded files). */
export const BACKUP_PREFIX = "backups/";
/** Where uploaded files live; what a backup's `files` section covers. */
export const FILES_PREFIX = "attachments/";

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "NotFound" || code === "NoSuchKey" || code === "NoSuchObject";
}

export class S3ObjectStore implements ObjectStore {
  /** The app's own bucket by default; the offsite copy passes its own client and bucket. */
  constructor(private readonly target: () => { client: Client; bucket: string } = getS3) {}

  async stat(key: string): Promise<{ size: number } | null> {
    const { client, bucket } = this.target();
    try {
      const s = await client.statObject(bucket, key);
      return { size: s.size };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const { client, bucket } = this.target();
    return client.getObject(bucket, key);
  }

  async put(key: string, body: Readable | Buffer, contentType: string, size?: number): Promise<void> {
    const { client, bucket } = this.target();
    if (Buffer.isBuffer(body)) {
      await client.putObject(bucket, key, body, body.length, { "Content-Type": contentType });
    } else if (size !== undefined) {
      await client.putObject(bucket, key, body, size, { "Content-Type": contentType });
    } else {
      await client.putObject(bucket, key, body, undefined, { "Content-Type": contentType });
    }
  }

  /**
   * One DELETE per key. minio's multi-object delete (`removeObjects`) is refused by Garage ("Invalid
   * delete XML query"), and it reports that as an error that is easy to swallow, so use the plain call.
   * Deleting a key that is not there is not an error.
   */
  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const { client, bucket } = this.target();
    for (let i = 0; i < keys.length; i += 8) {
      await Promise.all(keys.slice(i, i + 8).map((k) => client.removeObject(bucket, k)));
    }
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const { client, bucket } = this.target();
    const out: ObjectInfo[] = [];
    const stream = client.listObjectsV2(bucket, prefix, true);
    for await (const item of stream as AsyncIterable<{ name?: string; size?: number; lastModified?: Date }>) {
      if (item.name) out.push({ key: item.name, size: item.size ?? 0, lastModified: item.lastModified?.getTime() });
    }
    return out;
  }
}
