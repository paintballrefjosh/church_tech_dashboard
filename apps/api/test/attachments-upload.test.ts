import { describe, expect, it } from "vitest";
import { PayloadTooLargeException } from "@nestjs/common";
import { Readable } from "node:stream";
import { AttachmentsService } from "../src/attachments/attachments.service";
import type { Db } from "../src/db/db.module";
import type { SettingsService } from "../src/settings/settings.service";

// A cut-short upload must be refused before the database or the object store is touched; the fakes below throw if
// they are reached.
const untouched = new Proxy({}, { get: () => { throw new Error("storage reached"); } }) as unknown as Db;
const settings = { get: async () => undefined } as unknown as SettingsService;

function cutShort(): Readable {
  const s = Readable.from([Buffer.from("hello")]) as Readable & { truncated?: boolean };
  s.truncated = true;
  return s;
}

describe("AttachmentsService.upload", () => {
  it("refuses a file the multipart parser cut at the size limit", async () => {
    const svc = new AttachmentsService(untouched, settings);
    await expect(
      svc.upload("note", "00000000-0000-0000-0000-000000000000", null, {
        filename: "big.txt",
        mimetype: "text/plain",
        stream: cutShort(),
        sizeLimit: 0,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
