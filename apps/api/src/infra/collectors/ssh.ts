import { Client } from "ssh2";
import { createHash } from "node:crypto";
import type { CollectContext } from "./types";

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** sha256 fingerprint of the server host key seen this connect (base64). */
  hostKey: string | null;
}

export class SshHostKeyMismatchError extends Error {}

/**
 * Open an SSH connection, run one command, return its output, and close.
 *
 * Host-key handling is TOFU: the first connect records the key fingerprint
 * (returned as `hostKey` so the caller can persist it); every subsequent
 * connect must present the same fingerprint or we reject
 * (SshHostKeyMismatchError) rather than silently trust a changed key.
 *
 * We open a fresh connection per poll. At this app's fan-out (tens of hosts on
 * a ~30s cadence) the handshake cost is negligible and per-poll connections
 * keep the lifecycle trivial — no stale-socket handling.
 *
 * `execTimeoutMs` (opt-in — see below for what happens when it's omitted)
 * bounds the command itself, on top of `ctx.options.timeoutMs`'s connect
 * handshake bound. Needed for infra-updater's package-upgrade runs, which
 * can legitimately take many minutes; without a bound a hung/interactive
 * remote command would leave the exec promise (and the caller's run row, or
 * the InfraCollector target it's polling for) pending forever. On timeout we
 * close the local connection and reject — this does NOT kill the remote
 * process (ssh2 exposes no signal-delivery primitive here), so a
 * long-running upgrade keeps going on the host; we just stop waiting on it
 * from this side.
 *
 * The deadline covers the WHOLE operation from the moment sshExec is called
 * (connect, auth, channel-open, exec, and reading the command's output) —
 * not just "from once conn.exec()'s callback has already fired", which an
 * earlier version got wrong: that left a real gap (e.g. the channel-open
 * request itself never getting acknowledged by an sshd that goes
 * unresponsive right after auth) with literally no timeout protection,
 * hanging the promise indefinitely — which in turn permanently stuck
 * InfraCollector's inFlight guard for that target, silently freezing all
 * its polling (scheduled AND manual "check now" clicks) until the api
 * process was restarted. `readyTimeout` below is ssh2's own connect-phase
 * timeout; this deadline is a from-request-start backstop on top of it that
 * doesn't depend on ssh2 correctly bounding every phase itself. Every
 * current caller passes `execTimeoutMs` explicitly (all the OS collectors,
 * infra-updater); if a future caller omits it, the deadline falls back to
 * just the connect timeout, which is fine for a caller with nothing after
 * connect but too tight for one that also runs a real command — pass
 * `execTimeoutMs` if you're doing more than testing connectivity.
 */
export function sshExec(
  ctx: CollectContext,
  command: string,
  opts?: { execTimeoutMs?: number; stdin?: string },
): Promise<SshExecResult> {
  const cred = ctx.credential;
  if (!cred) return Promise.reject(new Error("SSH target has no credential configured"));

  const port = ctx.options.port ?? 22;
  const timeoutMs = ctx.options.timeoutMs ?? 15_000;
  const overallTimeoutMs = timeoutMs + (opts?.execTimeoutMs ?? 0);

  return new Promise<SshExecResult>((resolve, reject) => {
    const conn = new Client();
    let seenHostKey: string | null = ctx.knownHostKey ?? null;
    let settled = false;

    const done = (err: Error | null, res?: SshExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(res!);
    };

    const deadline = setTimeout(() => {
      done(new Error(`ssh operation timed out after ${overallTimeoutMs}ms`));
    }, overallTimeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return done(err);
        let stdout = "";
        let stderr = "";
        let code: number | null = null;
        stream
          .on("close", (exitCode: number | null) => {
            code = exitCode;
            done(null, { stdout, stderr, code, hostKey: seenHostKey });
          })
          .on("data", (d: Buffer) => {
            stdout += d.toString("utf8");
          });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        if (opts?.stdin !== undefined) stream.end(opts.stdin);
      });
    });

    conn.on("error", (err) => done(err as Error));

    // Some sshd configs (UniFi OS/UDM Pro notably) only advertise
    // keyboard-interactive, not password, as an auth method. ssh2 cascades
    // through every method the server allows in one connect attempt (password
    // first, keyboard-interactive after), so offering both here means a
    // password-auth rejection automatically falls back to answering the
    // keyboard-interactive prompt with the same password rather than failing
    // outright with "all configured authentication methods failed".
    const password = cred.authType === "ssh_password" ? cred.secret ?? undefined : undefined;
    if (password !== undefined) {
      conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => password));
      });
    }

    conn.connect({
      host: ctx.host,
      port,
      username: cred.username ?? "root",
      privateKey: cred.authType === "ssh_key" ? cred.secret ?? undefined : undefined,
      passphrase: cred.authType === "ssh_key" ? cred.extra ?? undefined : undefined,
      password,
      tryKeyboard: password !== undefined,
      readyTimeout: timeoutMs,
      // TOFU host-key verification. ssh2 hands us the raw host key; we fingerprint
      // it and compare to the pinned value.
      hostVerifier: (key: Buffer) => {
        const fp = createHash("sha256").update(key).digest("base64");
        seenHostKey = fp;
        if (ctx.knownHostKey && ctx.knownHostKey !== fp) return false;
        return true;
      },
    });
  });
}
