import { Injectable, BadRequestException } from "@nestjs/common";
import { Readable } from "node:stream";
import { MAX_IMPORT_SOURCE_BYTES, type WikiAclEntry, type WikiVisibility } from "@church/shared";
import { WikiService } from "../wiki.service";
import { AttachmentsService } from "../../attachments/attachments.service";
import type { AuthenticatedUser } from "../../auth/current-user.decorator";
import { convertDocx } from "./docx-converter";
import { convertPdf } from "./pdf-converter";
import { textToMarkdown } from "./text-converter";
import type { UploadImage } from "./types";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type ImportKind = "docx" | "pdf" | "txt";

export interface ImportFileInput {
  filename: string;
  mimetype: string;
  buffer: Buffer;
  title?: string;
  visibility?: WikiVisibility;
  acl?: WikiAclEntry[];
  parentId?: string | null;
  parentFolderId?: string | null;
}

/**
 * Turns an uploaded .docx/.txt/.pdf into a new wiki page — the same
 * mechanical steps as a manual import (create an empty page, convert the
 * source, upload any embedded images as real attachments along the way,
 * write the final body). It's deliberately just the mechanical part: no
 * banners, diagrams, or editorial judgment about layout — that stays a
 * follow-up pass on the resulting draft.
 */
@Injectable()
export class WikiImportService {
  constructor(
    private readonly wiki: WikiService,
    private readonly attachments: AttachmentsService,
  ) {}

  async import(user: AuthenticatedUser, input: ImportFileInput) {
    if (input.buffer.length === 0) throw new BadRequestException("Empty upload");
    if (input.buffer.length > MAX_IMPORT_SOURCE_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${Math.floor(MAX_IMPORT_SOURCE_BYTES / (1024 * 1024))} MiB import limit`,
      );
    }
    const kind = detectKind(input.filename, input.mimetype);
    if (!kind) {
      throw new BadRequestException("Unsupported file type — only .docx, .txt, and .pdf are supported");
    }

    const title = (input.title ?? stripExt(input.filename)).trim() || "Untitled import";
    const page = await this.wiki.create(user, {
      title,
      body: "",
      visibility: input.visibility ?? "public",
      acl: input.acl ?? [],
      parentId: input.parentId ?? null,
      parentFolderId: input.parentFolderId ?? null,
    });

    const uploadImage: UploadImage = async (image) => {
      const stored = await this.attachments.upload("wiki_page", page.id, user.id, {
        filename: image.filename,
        mimetype: image.mimetype,
        stream: Readable.from(image.buffer),
        sizeLimit: 0,
      });
      return `/api/wiki/${page.id}/attachments/${stored.id}`;
    };

    let body: string;
    try {
      if (kind === "docx") {
        body = await convertDocx(input.buffer, uploadImage);
      } else if (kind === "pdf") {
        body = await convertPdf(input.buffer);
      } else {
        body = textToMarkdown(input.buffer.toString("utf-8"));
      }
    } catch (err) {
      // Don't leave an empty orphan page (or its partially-uploaded images)
      // behind if conversion fails partway through.
      await this.wiki.delete(user, page.id).catch(() => {});
      throw new BadRequestException(
        `Couldn't read that file: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }

    // Keep the original upload attached for provenance — best-effort, not
    // worth failing the import over (e.g. a source file the size checks
    // above allow but that AttachmentsService itself still rejects).
    await this.attachments
      .upload("wiki_page", page.id, user.id, {
        filename: input.filename,
        mimetype: input.mimetype,
        stream: Readable.from(input.buffer),
        sizeLimit: 0,
      })
      .catch(() => {});

    return this.wiki.update(user, page.id, {
      body,
      summary: `Imported from ${input.filename}`,
    });
  }
}

function detectKind(filename: string, mimetype: string): ImportKind | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "docx" || mimetype === DOCX_MIME) return "docx";
  if (ext === "pdf" || mimetype === "application/pdf") return "pdf";
  if (ext === "txt" || mimetype === "text/plain") return "txt";
  return null;
}

function stripExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}
