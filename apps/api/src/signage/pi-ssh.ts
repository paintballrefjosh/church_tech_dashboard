import { createHash } from "node:crypto";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";
import { SshHostKeyMismatchError } from "../infra/collectors/ssh";

export { SshHostKeyMismatchError };

/**
 * SSH to a signage Pi (docs/signage.md sections 3, 5). One connection carries several commands (a sync copies many files
 * in one session). The host key is pinned: a different key is refused BEFORE any password or key is offered. Commands are
 * fixed strings built by the caller from validated values; files go in on stdin, never in a command line.
 */

export interface PiLogin {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
  knownHostKey: string | null;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export class PiSshError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "auth" | "host_key" | "timeout" | "command",
  ) {
    super(message);
  }
}

/** Plain words for ssh2's errors. */
export function describeSshError(err: unknown): PiSshError {
  if (err instanceof PiSshError) return err;
  if (err instanceof SshHostKeyMismatchError) return new PiSshError(err.message, "host_key");
  const e = err as { message?: string; level?: string; code?: string };
  const msg = e.message ?? String(err);
  if (e.level === "client-authentication" || /authentication methods failed/i.test(msg)) return new PiSshError("The Pi refused the login (wrong user name, password or key).", "auth");
  if (e.code === "ECONNREFUSED") return new PiSshError("Nothing answers on the SSH port (is SSH switched on in Imager?).", "unreachable");
  if (e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" || e.code === "ETIMEDOUT" || /timed out/i.test(msg)) return new PiSshError("The Pi does not answer (off, on another network, or blocked by a firewall).", "unreachable");
  return new PiSshError(msg, "unreachable");
}

export class PiSession {
  /** sha256 of the host key seen (base64), for pinning on first use. */
  hostKey: string | null = null;

  private constructor(private readonly conn: Client) {}

  static open(login: PiLogin): Promise<PiSession> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const session = new PiSession(conn);
      let mismatch = false;
      let settled = false;
      const timeoutMs = login.timeoutMs ?? 15_000;
      const done = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try {
            conn.end();
          } catch {
            /* ignore */
          }
          reject(describeSshError(mismatch ? new SshHostKeyMismatchError("The Pi's SSH host key is not the one recorded: it was re-flashed or replaced, or something is in between.") : err));
        } else resolve(session);
      };
      const timer = setTimeout(() => done(new PiSshError("The Pi did not finish the SSH login in time.", "timeout")), timeoutMs + 2_000);
      conn.on("ready", () => done(null));
      conn.on("error", (err) => done(err));
      if (login.password) conn.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => login.password!)));
      const cfg: ConnectConfig = {
        host: login.host,
        port: login.port,
        username: login.username,
        privateKey: login.privateKey,
        password: login.password,
        tryKeyboard: !!login.password,
        readyTimeout: timeoutMs,
        keepaliveInterval: 10_000,
        hostVerifier: (key: Buffer) => {
          const fp = createHash("sha256").update(key).digest("base64");
          session.hostKey = fp;
          if (login.knownHostKey && login.knownHostKey !== fp) {
            mismatch = true;
            return false;
          }
          return true;
        },
      };
      conn.connect(cfg);
    });
  }

  /** Run one command. `stdin` may be a buffer, a string or a stream (a file copied from the object store). */
  exec(command: string, opts: { stdin?: Buffer | string | Readable; timeoutMs?: number; maxStdout?: number; onStderr?: (text: string) => void } = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxStdout = opts.maxStdout ?? 8 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new PiSshError(`The command took longer than ${Math.round(timeoutMs / 1000)} s.`, "timeout"));
      }, timeoutMs);
      this.conn.exec(command, (err, stream) => {
        if (err) {
          settled = true;
          clearTimeout(timer);
          return reject(describeSshError(err));
        }
        const out: Buffer[] = [];
        let outBytes = 0;
        let stderr = "";
        stream.on("data", (d: Buffer) => {
          outBytes += d.length;
          if (outBytes <= maxStdout) out.push(d);
        });
        stream.stderr.on("data", (d: Buffer) => {
          opts.onStderr?.(d.toString("utf8"));
          stderr += d.toString("utf8");
          if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        });
        stream.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout: Buffer.concat(out), stderr });
        });
        const input = opts.stdin;
        if (input === undefined) stream.end();
        else if (typeof input === "string" || Buffer.isBuffer(input)) stream.end(input);
        else {
          input.on("error", (e) => {
            stream.close();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new PiSshError(`Reading the file to send failed: ${e.message}`, "command"));
            }
          });
          input.pipe(stream);
        }
      });
    });
  }

  close(): void {
    try {
      this.conn.end();
    } catch {
      /* ignore */
    }
  }
}

/** Run `fn` with an open session and always close it. */
export async function withPi<T>(login: PiLogin, fn: (s: PiSession) => Promise<T>): Promise<T> {
  const s = await PiSession.open(login);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

/**
 * What discovery learns WITHOUT logging in: whether port 22 answers, the SSH banner line, and the host key (a handshake that
 * is abandoned at the host-key step, before any user name or password is sent).
 */
export async function peekSsh(host: string, port: number, timeoutMs: number): Promise<{ open: boolean; banner: string | null; hostKey: string | null }> {
  const banner = await new Promise<{ open: boolean; banner: string | null }>((resolve) => {
    const sock = new Socket();
    let buf = "";
    let opened = false;
    const finish = (r: { open: boolean; banner: string | null }) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({ open: opened, banner: null }));
    sock.once("error", () => finish({ open: opened, banner: null }));
    sock.connect(port, host, () => {
      opened = true;
    });
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      const line = buf.split(/\r?\n/).find((l) => l.startsWith("SSH-"));
      if (line) finish({ open: true, banner: line.slice(0, 200) });
      else if (buf.length > 4096) finish({ open: true, banner: null });
    });
  });
  if (!banner.open) return { open: false, banner: null, hostKey: null };
  const hostKey = await new Promise<string | null>((resolve) => {
    const conn = new Client();
    let key: string | null = null;
    const end = () => {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      resolve(key);
    };
    const t = setTimeout(end, timeoutMs + 2_000);
    conn.on("error", () => {
      clearTimeout(t);
      end();
    });
    conn.on("ready", () => {
      clearTimeout(t);
      end();
    });
    conn.connect({
      host,
      port,
      username: "lampstand-signage-probe",
      readyTimeout: timeoutMs,
      hostVerifier: (k: Buffer) => {
        key = createHash("sha256").update(k).digest("base64");
        // Stop here: nothing is offered to the host.
        return false;
      },
    });
  });
  return { open: true, banner: banner.banner, hostKey };
}

/** The dashboard's own address as the Pi sees it (`SSH_CONNECTION` is "client port server port"). */
export function parseSshConnection(text: string): string | null {
  const ip = text.trim().split(/\s+/)[0] ?? "";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
}
