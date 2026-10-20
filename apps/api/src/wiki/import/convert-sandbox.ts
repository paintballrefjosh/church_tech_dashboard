import { fork } from "node:child_process";
import { Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "@church/shared";
import type { UploadImage } from "./types";

/**
 * Reads an uploaded .docx or .pdf in a CHILD PROCESS with a clock and a memory ceiling.
 *
 * Both formats are containers a stranger controls: a 1.5 MB .docx (a zip) can hold a picture that inflates to
 * 1.5 GB, and a 0.5 MB .pdf a page whose content stream does the same. The parsers (mammoth, pdf.js 1.10 inside
 * pdf-parse) inflate in memory without a limit, and a plain `--max-old-space-size` does not cap what they use,
 * because typed arrays live outside the JavaScript heap. Run in the API process, one such file from any signed-in
 * volunteer (the baseline `user` group may import) took the whole node down; both were reproduced in a 1 GiB
 * container (exit 137). So the parser runs in a child that is killed when it
 *   - grows past `maxRssBytes` (read from /proc every 100 ms; where /proc is missing only the clock applies), or
 *   - runs longer than `timeoutMs` (a parser stuck in a loop also blocks an event loop it shares), or
 *   - dies on its own,
 * and the API answers "could not read that file". The child is given an EMPTY environment (no secrets) and no
 * database. Embedded images come back over the channel and are stored by the API, within the limits below.
 */
export interface SandboxOptions {
  /** The compiled worker; tests point this at a stand-in. */
  workerPath?: string;
  timeoutMs?: number;
  maxRssBytes?: number;
  maxHeapMb?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxImageTotalBytes?: number;
  /** Tests give their own; imports share one per process. */
  limiter?: ConversionLimiter;
}

export const SANDBOX_DEFAULTS = {
  timeoutMs: 60_000,
  maxRssBytes: 768 * 1024 * 1024,
  maxHeapMb: 512,
  maxImages: 200,
  maxImageBytes: MAX_ATTACHMENT_BYTES,
  maxImageTotalBytes: 100 * 1024 * 1024,
} as const;

/** A file the importer refuses to read; the message is for the person and complete as it stands. */
export class ConversionRefused extends Error {
  /** True when the importer is simply occupied (answer "try again"), not when the file is the problem. */
  constructor(message: string, readonly busy = false) {
    super(message);
  }
}

/**
 * At most `max` conversions run at once in this process and at most `maxWaiting` wait their turn; the rest are turned
 * away. Each child may use `maxRssBytes`, so without this a handful of simultaneous imports (one account is enough)
 * would still add up to more memory than the node has.
 */
export class ConversionLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      if (this.queue.length >= this.maxWaiting) {
        throw new ConversionRefused("The importer is busy with other files. Try again in a minute.", true);
      }
      await new Promise<void>((go) => this.queue.push(go));
    } else {
      this.running += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // hands the slot straight on
      else this.running -= 1;
    }
  }
}

/** Shared by every import on this node. */
const defaultLimiter = new ConversionLimiter(2, 6);

const WHY = {
  memory:
    "That file expands to far more than the importer will handle, so it was stopped. It may be damaged; try saving it again from the program that made it.",
  time: "Reading that file took too long and was stopped. Try a smaller or simpler file.",
  died: "That file could not be read (the converter stopped unexpectedly). It may be damaged.",
} as const;

const log = new Logger("WikiImport");

function rssBytes(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export function convertInSandbox(
  kind: "docx" | "pdf",
  data: Buffer,
  uploadImage: UploadImage,
  options: SandboxOptions = {},
): Promise<string> {
  return (options.limiter ?? defaultLimiter).run(() => convertNow(kind, data, uploadImage, options));
}

function convertNow(kind: "docx" | "pdf", data: Buffer, uploadImage: UploadImage, options: SandboxOptions): Promise<string> {
  const o = { ...SANDBOX_DEFAULTS, ...options };
  const workerPath = options.workerPath ?? join(__dirname, "convert-worker.js");

  return new Promise<string>((resolve, reject) => {
    const child = fork(workerPath, [], {
      execArgv: [`--max-old-space-size=${o.maxHeapMb}`],
      env: {},
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString("utf8");
    });

    let settled = false;
    let cause: keyof typeof WHY | null = null;
    let images = 0;
    let imageBytes = 0;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      clearInterval(watch);
      if (child.exitCode === null) child.kill("SIGKILL");
      fn();
    };
    const stop = (why: keyof typeof WHY) => {
      cause = why;
      if (child.exitCode === null) child.kill("SIGKILL");
    };

    const clock = setTimeout(() => stop("time"), o.timeoutMs);
    const watch = setInterval(() => {
      if (!child.pid) return;
      const rss = rssBytes(child.pid);
      if (rss !== null && rss > o.maxRssBytes) stop("memory");
    }, 100);

    child.on("message", (m: { type: string; [k: string]: unknown }) => {
      if (m.type === "done") {
        const markdown = String(m.markdown ?? "");
        return done(() => resolve(markdown));
      }
      if (m.type === "error") {
        const message = String(m.message ?? "unknown error");
        return done(() => reject(new ConversionRefused(`Couldn't read that file: ${message}`)));
      }
      if (m.type === "image") {
        const id = Number(m.id);
        const bytes = m.data as Uint8Array;
        const reply = (url: string | null) => {
          if (!settled && child.connected) child.send({ type: "image-url", id, url });
        };
        // Too many, too large: the picture is left out of the page, not the whole import.
        images += 1;
        imageBytes += bytes.byteLength;
        if (images > o.maxImages || bytes.byteLength > o.maxImageBytes || imageBytes > o.maxImageTotalBytes) return reply(null);
        uploadImage({
          filename: String(m.filename),
          mimetype: String(m.mimetype),
          buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        }).then(reply, () => reply(null));
      }
    });
    // The child ended without a result. Its channel delivers any last message before it closes ("disconnect"); "exit"
    // is the fallback for a channel that never closes cleanly.
    const ended = () =>
      done(() => {
        if (cause === null) log.warn(`import converter (${kind}) ended without a result: ${stderr.trim().slice(-300) || "no output"}`);
        reject(new ConversionRefused(WHY[cause ?? "died"]));
      });
    child.on("error", ended);
    child.on("disconnect", ended);
    child.on("exit", () => setTimeout(ended, 250));

    child.send({ type: "convert", kind, data }, (err) => {
      if (err) done(() => reject(new ConversionRefused(WHY.died)));
    });
  });
}
