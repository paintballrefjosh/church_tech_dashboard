import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The signage agent release the API carries (services/signage-agent, copied into the image at /app/signage-agent). It is
 * packed here as a tar.gz that is the same bytes for the same files (fixed order, times and owners), so every node of a
 * cluster offers the same sha256 and a Pi is not told to update by a node that merely packed it again.
 */

export interface AgentBundle {
  version: string;
  sha256: string;
  bytes: Buffer;
}

const SKIP = /(^|\/)(tests|__pycache__|\.pytest_cache)(\/|$)|\.pyc$/;

export function agentSourceDir(): string | null {
  const candidates = [process.env.SIGNAGE_AGENT_DIR, "/app/signage-agent", resolve(__dirname, "../../../../services/signage-agent"), resolve(process.cwd(), "../../services/signage-agent")];
  for (const c of candidates) if (c && existsSync(join(c, "VERSION"))) return c;
  return null;
}

function header(name: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error(`path too long for the agent bundle: ${name}`);
  h.write(name, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** Pack a folder as a deterministic tar.gz (directories 755, executables 755, other files 644). */
export function packDir(dir: string): Buffer {
  const parts: Buffer[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(dir, full).split("\\").join("/");
      if (SKIP.test(rel)) continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        parts.push(header(`${rel}/`, 0, 0o755, "5"));
        walk(full);
      } else if (st.isFile()) {
        const data = readFileSync(full);
        parts.push(header(rel, data.length, st.mode & 0o111 ? 0o755 : 0o644, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
      }
    }
  };
  walk(dir);
  parts.push(Buffer.alloc(1024));
  // gzip's header has no file name and a zero time when given a buffer, so the output depends on the bytes only.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** The VERSION file inside a release tar.gz (an uploaded release names itself). Null when it has none. */
export function versionInBundle(tgz: Buffer): string | null {
  const tar = gunzipSync(tgz, { maxOutputLength: 64 * 1024 * 1024 });
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const size = parseInt(h.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const body = off + 512;
    if (name === "VERSION" || name === "./VERSION") return tar.toString("utf8", body, body + size).trim();
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

let cached: AgentBundle | null | undefined;

/** The release bundled with this API build (cached for the life of the process). */
export function bundledAgent(): AgentBundle | null {
  if (cached !== undefined) return cached;
  const dir = agentSourceDir();
  if (!dir) return (cached = null);
  const bytes = packDir(dir);
  cached = { version: readFileSync(join(dir, "VERSION"), "utf8").trim(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  return cached;
}

/** Compare "1.2.10" and "1.10.0" as versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
