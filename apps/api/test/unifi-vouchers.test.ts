import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUnifiVouchersSchema, describeVoucherMinutes } from "@church/shared";
import { UnifiService, toVoucher } from "../src/unifi/unifi.service";

/** A fake self-hosted controller: the UniFi OS path (/proxy/network/...) answers 404, so the service falls back to /api/. */
describe("UniFi guest vouchers", () => {
  let server: Server;
  let base = "";
  const posts: unknown[] = [];
  let vouchers: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "k") return res.writeHead(401).end();
      if (req.url?.startsWith("/proxy/network/")) return res.writeHead(404).end();
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && req.url === "/api/s/default/stat/voucher") return res.end(JSON.stringify({ data: vouchers }));
        if (req.method === "POST" && req.url === "/api/s/default/cmd/hotspot") {
          const cmd = JSON.parse(body) as { cmd: string; n?: number; expire?: number; quota?: number; note?: string; _id?: string };
          posts.push(cmd);
          if (cmd.cmd === "create-voucher") {
            for (let i = 0; i < (cmd.n ?? 1); i++) {
              vouchers.push({ _id: `aaaaaaaaaaaaaaaaaaaaaaa${i}`, code: `123456789${i}`, create_time: 1793000000, duration: cmd.expire, quota: cmd.quota, note: cmd.note, used: 0, status: "VALID_ONE" });
            }
            return res.end(JSON.stringify({ data: [{ create_time: 1793000000 }] }));
          }
          if (cmd.cmd === "delete-voucher") {
            vouchers = vouchers.filter((v) => v._id !== cmd._id);
            return res.end(JSON.stringify({ data: [] }));
          }
        }
        res.writeHead(400).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const service = () => {
    const values: Record<string, unknown> = { "unifi.controller_url": base, "unifi.api_key": "k", "unifi.site_id": "default", "unifi.verify_tls": false };
    return new UnifiService({ get: async (k: string) => values[k] } as never, {} as never);
  };

  it("creates a batch and returns exactly it, then revokes one", async () => {
    vouchers = [{ _id: "bbbbbbbbbbbbbbbbbbbbbbbb", code: "5555566666", create_time: 1700000000, duration: 60, quota: 1, status: "VALID_ONE" }];
    const made = await service().createVouchers(createUnifiVouchersSchema.parse({ count: 3, minutes: 240, note: "Youth retreat" }));
    expect(made).toHaveLength(3);
    expect(made[0]).toMatchObject({ code: "12345-67890", minutes: 240, uses: 1, note: "Youth retreat" });
    expect(posts.at(-1)).toMatchObject({ cmd: "create-voucher", n: 3, expire: 240, quota: 1 });
    await service().revokeVoucher(made[0]!.id);
    expect((await service().vouchers()).map((v) => v.id)).not.toContain(made[0]!.id);
  });

  it("maps the controller's fields and words the length", () => {
    expect(toVoucher({ _id: "x", code: "0000012345", create_time: 0, duration: 1440, quota: 0, status_expires: 1793000000 })).toMatchObject({
      code: "00000-12345",
      minutes: 1440,
      uses: 0,
      expiresAt: new Date(1793000000 * 1000).toISOString(),
    });
    expect(describeVoucherMinutes(240)).toBe("4 hours");
    expect(describeVoucherMinutes(2880)).toBe("2 days");
    expect(describeVoucherMinutes(10080)).toBe("1 week");
    expect(createUnifiVouchersSchema.safeParse({ count: 500, minutes: 60 }).success).toBe(false);
  });
});

describe("UniFi Protect cameras", () => {
  it("maps Protect's fields; only CONNECTED is online", async () => {
    const { toCamera } = await import("../src/unifi/unifi.service");
    expect(toCamera({ id: "c1", name: "Front door", state: "CONNECTED", mac: "AA", marketName: "G4 Bullet" })).toEqual({
      id: "c1", name: "Front door", state: "CONNECTED", online: true, mac: "AA", model: "G4 Bullet",
    });
    expect(toCamera({ id: "c2", state: "disconnected", type: "UVC G3" })).toMatchObject({ name: "Camera", online: false, state: "DISCONNECTED", model: "UVC G3" });
  });
  it("reports switched off without asking the console", async () => {
    const svc = new UnifiService({ get: async () => undefined } as never, {} as never);
    expect(await svc.cameras()).toEqual({ enabled: false, cameras: [], error: null });
  });
});
