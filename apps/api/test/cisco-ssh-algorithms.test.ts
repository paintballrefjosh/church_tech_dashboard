import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { sshShell } from "../src/cisco/ssh";

/**
 * A switch that speaks both modern and ancient SSH. The client's list order decides which one is used (RFC 4253: the
 * first algorithm on the CLIENT's list that the server also has), so a list that starts with the oldest ones makes a
 * modern switch talk group1-sha1 and CBC ciphers with the password. The old ones must stay available (old IOS boxes
 * need them) but last.
 */
interface Negotiated {
  kex: string;
  cipher: string;
  mac: string;
}

function startServer() {
  const pair = utils.generateKeyPairSync("ed25519");
  let negotiated: Negotiated | null = null;
  const server = new Server(
    {
      hostKeys: [pair.private],
      algorithms: {
        kex: [
          "diffie-hellman-group1-sha1", "diffie-hellman-group14-sha1", "diffie-hellman-group14-sha256", "diffie-hellman-group16-sha512",
          "ecdh-sha2-nistp256", "curve25519-sha256",
        ],
        cipher: ["aes128-cbc", "3des-cbc", "aes256-cbc", "aes128-ctr", "aes256-ctr", "aes256-gcm@openssh.com", "aes128-gcm@openssh.com"],
        hmac: ["hmac-sha1", "hmac-sha2-256", "hmac-sha2-512"],
        serverHostKey: ["ssh-ed25519"],
      },
    } as never,
    (client) => {
      client.on("handshake", (n: { kex: string; cs: { cipher: string; mac: string } }) => {
        negotiated = { kex: n.kex, cipher: n.cs.cipher, mac: n.cs.mac };
      });
      client.on("authentication", (ctx) => ctx.accept());
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
    },
  );
  const port = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  return { server, port, negotiated: () => negotiated };
}

describe("Cisco SSH algorithm preference", () => {
  const s = startServer();
  let port = 0;
  beforeAll(async () => {
    port = await s.port;
  });
  afterAll(() => s.server.close());

  it("uses the strongest algorithms a switch offers, not the oldest", async () => {
    await sshShell({ host: "127.0.0.1", port, username: "u", password: "p", timeoutMs: 3000 }, []);
    const n = s.negotiated();
    expect(n).not.toBeNull();
    expect(n!.kex).not.toMatch(/group1|sha1/);
    expect(n!.cipher).not.toMatch(/cbc|3des/);
    expect(n!.mac).not.toBe("hmac-sha1");
  });
});
