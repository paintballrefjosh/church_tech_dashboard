import { describe, expect, it, vi } from "vitest";
import { HIDDEN, isSecretKey, needsScrub, scrubSnapshot } from "../src/audit/audit-scrub";
import { AuditService } from "../src/audit/audit.service";

describe("scrubSnapshot", () => {
  it("hides a credential at any depth", () => {
    const out = scrubSnapshot({
      id: "m1",
      name: "api",
      options: { headers: { Authorization: "Bearer abc", Accept: "json" }, url: "https://x" },
      list: [{ snmpCommunity: "public" }],
    });
    expect(out).toEqual({
      id: "m1",
      name: "api",
      options: { headers: { Authorization: HIDDEN, Accept: "json" }, url: "https://x" },
      list: [{ snmpCommunity: HIDDEN }],
    });
  });

  it("leaves booleans, null, empty values and identifiers alone", () => {
    const row = { hasPassword: true, password: null, token: "", apiTokenId: "t1", prefix: "cdt_x7Kq", tokenPrefix: "cdt_", mustChangePassword: false, api_tokens: 3 };
    expect(scrubSnapshot(row)).toEqual(row);
    expect(needsScrub(row)).toBe(false);
  });

  it("does not change its input and is stable when repeated", () => {
    const input = { password: "hunter2" };
    const once = scrubSnapshot(input);
    expect(input.password).toBe("hunter2");
    expect(scrubSnapshot(once)).toEqual(once);
    expect(needsScrub(input)).toBe(true);
    expect(needsScrub(once)).toBe(false);
  });

  it("passes non-objects through", () => {
    expect(scrubSnapshot(null)).toBeNull();
    expect(scrubSnapshot("x")).toBe("x");
    expect(isSecretKey("sudoPassword")).toBe(true);
    expect(isSecretKey("name")).toBe(false);
  });
});

describe("AuditService.write", () => {
  it("stores the scrubbed snapshot, never the secret", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: () => ({ values }) };
    const svc = new AuditService(db as never, {} as never, { register: vi.fn() } as never, {} as never);
    await svc.write({ action: "monitor.create", resourceType: "monitor", after: { id: "m", options: { headers: { Authorization: "Bearer sekrit" } } } });
    const saved = values.mock.calls[0]![0] as { after: unknown };
    expect(JSON.stringify(saved.after)).not.toContain("sekrit");
    expect(JSON.stringify(saved.after)).toContain(HIDDEN);
  });
});
