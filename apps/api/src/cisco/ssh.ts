import { Client, type ClientChannel } from "ssh2";

/**
 * Interactive-shell SSH runner for Cisco devices, ported from the cisco-switch
 * app's `sshShell`. Cisco CLI needs a real PTY (no exec channel), paging turned
 * off via `terminal length 0`, and tolerance for `--More--` prompts and slow
 * banners. We also force-enable legacy KEX/cipher/HMAC/host-key algorithms so
 * old IOS boxes negotiate at all.
 *
 * The login user is assumed to already land in privileged EXEC (prompt `#`) —
 * there is no `enable` step, matching the source app.
 *
 * Resolves with the accumulated shell output; only a connection-level failure
 * rejects (a slow/stuck device resolves with whatever was captured).
 */

export interface SshShellOpts {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}

const LEGACY_ALGORITHMS = {
  kex: [
    "diffie-hellman-group1-sha1",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group-exchange-sha1",
    "diffie-hellman-group14-sha256",
    "diffie-hellman-group16-sha512",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "curve25519-sha256",
    "curve25519-sha256@libssh.org",
  ],
  cipher: [
    "aes128-cbc",
    "aes192-cbc",
    "aes256-cbc",
    "3des-cbc",
    "aes128-ctr",
    "aes192-ctr",
    "aes256-ctr",
    "aes128-gcm@openssh.com",
    "aes256-gcm@openssh.com",
  ],
  serverHostKey: [
    "ssh-rsa",
    "ssh-dss",
    "rsa-sha2-256",
    "rsa-sha2-512",
    "ecdsa-sha2-nistp256",
    "ssh-ed25519",
  ],
  hmac: ["hmac-sha1", "hmac-sha2-256", "hmac-sha2-512"],
} as const;

const QUIET_MS = 1500;
const MAX_NUDGES = 5;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export function sshShell(opts: SshShellOpts, commands: string[]): Promise<string> {
  const allCmds = ["terminal length 0", ...commands];

  return new Promise<string>((resolve, reject) => {
    const conn = new Client();
    let stream: ClientChannel | null = null;
    let output = "";
    let buffer = "";
    let idx = 0;
    let nudges = 0;
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    // Global watchdog: give up (with whatever we have) if the whole exchange
    // overruns roughly one timeout window per command plus slack.
    const watchdog = setTimeout(() => finish(), opts.timeoutMs * (allCmds.length + 4));

    function done(err: Error | null, res?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (quietTimer) clearTimeout(quietTimer);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(res ?? output);
    }

    function finish(): void {
      // Let the last command's output flush, then resolve.
      setTimeout(() => done(null, output), 2000);
    }

    function sendNext(): void {
      if (!stream) return;
      if (idx >= allCmds.length) {
        finish();
        return;
      }
      buffer = "";
      nudges = 0;
      stream.write(`${allCmds[idx++]}\n`);
    }

    function onQuiet(): void {
      if (settled || !stream) return;
      const tail = stripAnsi(buffer).slice(-240);
      if (/--More--|---- More ----|<--- More --->/.test(tail)) {
        stream.write(" ");
        return;
      }
      if (/[#>]\s*$/.test(tail)) {
        sendNext();
        return;
      }
      if (nudges++ < MAX_NUDGES) {
        stream.write("\n");
        return;
      }
      // Stuck — move on rather than hang the whole poll.
      sendNext();
    }

    conn.on("ready", () => {
      conn.shell({ term: "vt100", cols: 220, rows: 50 }, (err, s) => {
        if (err) return done(err);
        stream = s;
        s.on("data", (d: Buffer) => {
          const t = d.toString("utf8");
          output += t;
          buffer += t;
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(onQuiet, QUIET_MS);
        });
        s.stderr?.on("data", () => {
          /* Cisco writes everything to stdout; ignore */
        });
        s.on("close", () => done(null, output));
      });
    });
    conn.on("error", (e) => done(e as Error));

    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: opts.timeoutMs,
      // @ts-expect-error ssh2 accepts a partial algorithms override.
      algorithms: LEGACY_ALGORITHMS,
    });
  });
}
