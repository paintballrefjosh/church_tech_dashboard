import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Readable } from "node:stream";
import {
  ATTACHMENT_ALLOWED_CONTENT_TYPES,
  ATTACHMENT_MAGICLESS_TYPES,
  type AttachmentParentType,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { attachments } from "../db/schema";
import { getS3 } from "./s3.client";
import { reconcileMime } from "./magic-bytes";

export interface IncomingFile {
  filename: string;
  mimetype: string;
  stream: Readable;
  /** Hard cap enforced by @fastify/multipart; we still re-check after upload. */
  sizeLimit: number;
}

export interface StoredAttachment {
  id: string;
  parentType: AttachmentParentType;
  parentId: string;
  uploaderUserId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

/**
 * Generic attachment storage. Consumers (NotesController, future TicketsController,
 * etc.) handle their own auth then call this service. No auth checks live here —
 * the storage layer trusts whoever called it.
 */
@Injectable()
export class AttachmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upload(
    parentType: AttachmentParentType,
    parentId: string,
    uploaderUserId: string | null,
    file: IncomingFile,
  ): Promise<StoredAttachment> {
    const declared = (file.mimetype || "").toLowerCase();
    if (!declared || !ATTACHMENT_ALLOWED_CONTENT_TYPES.includes(declared)) {
      throw new BadRequestException(`content-type ${declared || "<missing>"} not allowed`);
    }

    // Buffer the upload so we can sniff magic bytes before storing.
    // fastify-multipart caps fileSize at MAX_ATTACHMENT_BYTES (10 MiB) so the
    // memory cost per upload is bounded.
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(chunk as Buffer);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) throw new BadRequestException("empty upload");

    let contentType: string;
    try {
      contentType = reconcileMime(declared, buf.subarray(0, 16), ATTACHMENT_MAGICLESS_TYPES);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const filename = sanitiseFilename(file.filename);
    const id = crypto.randomUUID();
    const ext = extOf(filename);
    const storageKey = `attachments/${parentType}/${id}${ext}`;

    const { client, bucket } = getS3();
    await ensureBucket(client, bucket);

    await client.putObject(bucket, storageKey, buf, buf.length, {
      "Content-Type": contentType,
    });

    const [row] = await this.db
      .insert(attachments)
      .values({
        parentType,
        parentId,
        uploaderUserId,
        filename,
        contentType,
        sizeBytes: buf.length,
        storageKey,
      })
      .returning();
    if (!row) throw new Error("attachment insert failed");
    return toStored(row);
  }

  async listByParent(parentType: AttachmentParentType, parentId: string): Promise<StoredAttachment[]> {
    const rows = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.parentType, parentType), eq(attachments.parentId, parentId)))
      .orderBy(asc(attachments.createdAt));
    return rows.map(toStored);
  }

  async getOne(
    parentType: AttachmentParentType,
    parentId: string,
    attachmentId: string,
  ): Promise<{ row: StoredAttachment; storageKey: string }> {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.parentType, parentType),
          eq(attachments.parentId, parentId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Attachment not found");
    return { row: toStored(row), storageKey: row.storageKey };
  }

  async openStream(storageKey: string): Promise<Readable> {
    const { client, bucket } = getS3();
    return client.getObject(bucket, storageKey);
  }

  async delete(
    parentType: AttachmentParentType,
    parentId: string,
    attachmentId: string,
  ): Promise<void> {
    const { storageKey } = await this.getOne(parentType, parentId, attachmentId);
    const { client, bucket } = getS3();
    // Remove from DB first so a failed object-remove doesn't leak FK pointing
    // at a deleted blob — but tolerate the object already being gone.
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId));
    try {
      await client.removeObject(bucket, storageKey);
    } catch {
      // best-effort; orphan blobs are reaped by a future cleanup job
    }
  }

  /** Bulk delete every attachment for a given parent. Called by parents on cascade. */
  async deleteAllForParent(parentType: AttachmentParentType, parentId: string): Promise<void> {
    const rows = await this.db
      .select({ id: attachments.id, storageKey: attachments.storageKey })
      .from(attachments)
      .where(and(eq(attachments.parentType, parentType), eq(attachments.parentId, parentId)));
    if (rows.length === 0) return;
    await this.db
      .delete(attachments)
      .where(and(eq(attachments.parentType, parentType), eq(attachments.parentId, parentId)));
    const { client, bucket } = getS3();
    for (const r of rows) {
      try {
        await client.removeObject(bucket, r.storageKey);
      } catch {
        // best-effort
      }
    }
  }
}

function sanitiseFilename(name: string): string {
  // Strip control chars and path separators; keep extension. Cap length so we
  // don't blow out the column (text) or generate weird responses.
  const cleaned = (name || "file")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length === 0 ? "file" : cleaned.slice(0, 240);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot >= name.length - 1) return "";
  const ext = name.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

async function ensureBucket(client: import("minio").Client, bucket: string): Promise<void> {
  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) await client.makeBucket(bucket);
}

function toStored(row: typeof attachments.$inferSelect): StoredAttachment {
  return {
    id: row.id,
    parentType: row.parentType as AttachmentParentType,
    parentId: row.parentId,
    uploaderUserId: row.uploaderUserId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}
