import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import type { SignageAgentRelease } from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { signageAgentReleases, signageDevices } from "../db/schema";
import { getS3 } from "../attachments/s3.client";
import { bundledAgent, versionInBundle, type AgentBundle } from "./agent-bundle";
import { signageReleaseKey } from "./constants";

const MAX_RELEASE_BYTES = 32 * 1024 * 1024;

/**
 * Agent releases (docs/signage.md section 10). The API image carries one (services/signage-agent); an admin may upload
 * another (a fix before the next dashboard release) and make it current. No signing: a release goes to a Pi only over the
 * pinned SSH session, and the Pi checks its sha256 before installing it.
 */
@Injectable()
export class SignageReleases {
  private cache: AgentBundle | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async list(): Promise<SignageAgentRelease[]> {
    const rows = await this.db.select().from(signageAgentReleases).orderBy(desc(signageAgentReleases.createdAt));
    const counts = await this.db.select({ v: signageDevices.agentVersion, n: sql<number>`count(*)` }).from(signageDevices).groupBy(signageDevices.agentVersion);
    const by = new Map(counts.map((c) => [c.v, Number(c.n)]));
    const b = bundledAgent();
    const anyCurrent = rows.some((r) => r.isCurrent);
    const out: SignageAgentRelease[] = rows.map((r) => ({ id: r.id, version: r.version, sha256: r.sha256, sizeBytes: r.sizeBytes, notes: r.notes, isCurrent: r.isCurrent, builtIn: false, createdAt: r.createdAt.toISOString(), devices: by.get(r.version) ?? 0 }));
    if (b) out.unshift({ id: "bundled", version: b.version, sha256: b.sha256, sizeBytes: b.bytes.length, notes: "Comes with this dashboard version.", isCurrent: !anyCurrent, builtIn: true, createdAt: new Date(0).toISOString(), devices: by.get(b.version) ?? 0 });
    return out;
  }

  /** The release the Pis should run. */
  async current(): Promise<AgentBundle | null> {
    const [row] = await this.db.select().from(signageAgentReleases).where(eq(signageAgentReleases.isCurrent, true)).limit(1);
    if (!row || !row.storageKey) return bundledAgent();
    if (this.cache?.sha256 === row.sha256) return this.cache;
    const { client, bucket } = getS3();
    const chunks: Buffer[] = [];
    for await (const c of await client.getObject(bucket, row.storageKey)) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new ConflictException("The stored agent release does not match its sha256.");
    this.cache = { version: row.version, sha256: row.sha256, bytes };
    return this.cache;
  }

  async upload(file: Readable, truncated: () => boolean, notes: string, userId: string | null): Promise<SignageAgentRelease> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of file) {
      size += (c as Buffer).length;
      if (size > MAX_RELEASE_BYTES) throw new PayloadTooLargeException("A release can be at most 32 MB.");
      chunks.push(c as Buffer);
    }
    if (truncated()) throw new PayloadTooLargeException("A release can be at most 32 MB.");
    const bytes = Buffer.concat(chunks);
    let version: string | null;
    try {
      version = versionInBundle(bytes);
    } catch {
      throw new BadRequestException("That is not a .tar.gz of services/signage-agent.");
    }
    if (!version || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) throw new BadRequestException("The release has no VERSION file with a version like 1.2.3.");
    const [dupe] = await this.db.select({ id: signageAgentReleases.id }).from(signageAgentReleases).where(eq(signageAgentReleases.version, version));
    if (dupe || bundledAgent()?.version === version) throw new ConflictException(`Version ${version} is already here: bump VERSION.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { client, bucket } = getS3();
    await client.putObject(bucket, signageReleaseKey(version), bytes, bytes.length, { "Content-Type": "application/gzip" });
    const [r] = await this.db.insert(signageAgentReleases).values({ version, sha256, sizeBytes: bytes.length, storageKey: signageReleaseKey(version), notes, createdBy: userId }).returning();
    return (await this.list()).find((x) => x.id === r!.id)!;
  }

  async setCurrent(id: string): Promise<SignageAgentRelease[]> {
    if (id !== "bundled") {
      const [r] = await this.db.select().from(signageAgentReleases).where(eq(signageAgentReleases.id, id));
      if (!r) throw new NotFoundException("No such release");
    }
    await this.db.transaction(async (tx) => {
      await tx.update(signageAgentReleases).set({ isCurrent: false }).where(eq(signageAgentReleases.isCurrent, true));
      if (id !== "bundled") await tx.update(signageAgentReleases).set({ isCurrent: true }).where(eq(signageAgentReleases.id, id));
    });
    return this.list();
  }
}
