import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { sshShell } from "../src/cisco/ssh";
import { SshHostKeyMismatchError } from "../src/infra/collectors/ssh";

function startServer(): { server: Server; port: Promise<number>; fingerprint: string; accepted: () => number } {
  const pair = utils.generateKeyPairSync("ed25519");
  const parsed = utils.parseKey(pair.public);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = createHash("sha256").update(parsed.getPublicSSH()).digest("base64");
  let authAttempts = 0;
  const server = new Server({ hostKeys: [pair.private] }, (client) => {
    client.on("authentication", (ctx) => {
      authAttempts++;
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("sw1#");
          stream.end();
        });
      });
    });
    client.on("error", () => undefined);
  });
  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { server, port, fingerprint, accepted: () => authAttempts };
}

describe("Cisco SSH host-key pinning", () => {
  const s = startServer();
  let port = 0;
  beforeAll(async () => {
    port = await s.port;
  });
  afterAll(() => {
    s.server.close();
  });

  const opts = (extra: object) => ({ host: "127.0.0.1", port, username: "u", password: "p", timeoutMs: 3000, ...extra });

  it("reports the key on first use so it can be pinned", async () => {
    let seen: string | null = null;
    await sshShell(opts({ knownHostKey: null, onHostKey: (fp: string) => (seen = fp) }), []);
    expect(seen).toBe(s.fingerprint);
  });

  it("connects when the pinned key matches", async () => {
    const before = s.accepted();
    await sshShell(opts({ knownHostKey: s.fingerprint }), []);
    expect(s.accepted()).toBe(before + 1);
  });

  it("refuses a different key before sending the password", async () => {
    const before = s.accepted();
    await expect(sshShell(opts({ knownHostKey: "AAAA-not-the-key" }), [])).rejects.toBeInstanceOf(SshHostKeyMismatchError);
    expect(s.accepted()).toBe(before);
  });
});
