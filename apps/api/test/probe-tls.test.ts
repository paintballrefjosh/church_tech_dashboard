import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:tls";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeTls, tlsVerdict } from "../../../services/monitor/src/probes";

const DAY = 86_400_000;

describe("tlsVerdict", () => {
  const now = Date.UTC(2026, 9, 15);
  it("is healthy with more than warnDays left", () => {
    expect(tlsVerdict(now + 40 * DAY, now, 21)).toEqual({ daysLeft: 40, ok: true });
  });
  it("fails at warnDays and below, so the incident opens while there is time to renew", () => {
    expect(tlsVerdict(now + 21 * DAY + 1000, now, 21).ok).toBe(false);
    expect(tlsVerdict(now + 22 * DAY + 1000, now, 21).ok).toBe(true);
    expect(tlsVerdict(now + 3 * DAY, now, 21).ok).toBe(false);
  });
  it("fails once expired, whatever the threshold", () => {
    expect(tlsVerdict(now - DAY, now, 1)).toEqual({ daysLeft: -1, ok: false });
    expect(tlsVerdict(now, now, 1).ok).toBe(false);
  });
});

/** Real handshakes against local servers whose certificates expire at known times (needs the openssl CLI). */
function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!haveOpenssl())("probeTls against a live TLS server", () => {
  const dir = mkdtempSync(join(tmpdir(), "tls-probe-"));
  const servers: Server[] = [];
  const ports: Record<string, number> = {};

  const makeCert = (name: string, days: number) => {
    const key = join(dir, `${name}.key`);
    const crt = join(dir, `${name}.crt`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", String(days), "-subj", "/CN=localhost"], { stdio: "ignore" });
    return { key: readFileSync(key), cert: readFileSync(crt) };
  };
  const listen = (name: string, creds: { key: Buffer; cert: Buffer }) =>
    new Promise<void>((resolve) => {
      const s = createServer(creds, (sock) => sock.end());
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        ports[name] = (s.address() as AddressInfo).port;
        resolve();
      });
    });

  beforeAll(async () => {
    await listen("long", makeCert("long", 90));
    await listen("soon", makeCert("soon", 5));
  });
  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is up for a certificate with plenty of time left, and says the chain is not trusted", async () => {
    const r = await probeTls({ target: "127.0.0.1", options: { port: ports.long, warnDays: 21 } });
    expect(r.ok).toBe(true);
    expect(r.info).toMatch(/expires \d{4}-\d{2}-\d{2} \(8\d days left\)/);
    expect(r.info).toContain("chain not trusted");
  });

  it("is down when the certificate is within the warning window", async () => {
    const r = await probeTls({ target: "127.0.0.1", options: { port: ports.soon, warnDays: 21 } });
    expect(r.ok).toBe(false);
    expect(r.info).toMatch(/\([3-5] days left\)/);
  });

  it("is up for the same short certificate when the threshold is lower", async () => {
    expect((await probeTls({ target: "127.0.0.1", options: { port: ports.soon, warnDays: 2 } })).ok).toBe(true);
  });

  it("accepts host:port and a pasted URL as the target", async () => {
    expect((await probeTls({ target: `127.0.0.1:${ports.long}`, options: {} })).ok).toBe(true);
    expect((await probeTls({ target: `https://127.0.0.1:${ports.long}/status`, options: {} })).ok).toBe(true);
  });

  it("reports a refused connection as down", async () => {
    const refused = await probeTls({ target: "127.0.0.1", options: { port: 1, timeoutMs: 2000 } });
    expect(refused.ok).toBe(false);
    expect(refused.info).toBeTruthy();
  });
});
