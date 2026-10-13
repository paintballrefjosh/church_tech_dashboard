import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HttpAdapterHost } from "@nestjs/core";
import {
  ApiBridge,
  BridgeError,
  buildRequest,
  capResult,
  errorText,
  type BridgeCaller,
} from "../src/mcp/bridge/api-bridge.service";
import { defineTool, pathParamNames } from "../src/mcp/bridge/bridge.types";
import { strictInput, toInputSchema } from "../src/mcp/bridge/bridge-schema";
import type { SettingsService } from "../src/settings/settings.service";

const ID = "11111111-1111-4111-8111-111111111111";

const getTool = defineTool({
  name: "t_get",
  title: "Get",
  description: "d",
  cls: "read",
  method: "GET",
  path: "/things/:id/parts/:part",
  commaKeys: ["ids"],
  permissions: [],
  input: z.object({
    id: z.string().uuid(),
    part: z.string(),
    kind: z.array(z.string()).optional(),
    ids: z.array(z.string()).optional(),
    limit: z.number().optional(),
    open: z.boolean().optional(),
  }),
});

const patchTool = defineTool({
  name: "t_patch",
  title: "Patch",
  description: "d",
  cls: "write",
  method: "PATCH",
  path: "/things/:id",
  permissions: [],
  input: z.object({ id: z.string().uuid(), title: z.string().optional(), dry: z.boolean().optional() }),
  queryKeys: ["dry"],
  link: (r) => `/things/${(r as { id: string }).id}`,
});

describe("buildRequest", () => {
  it("puts path params in the path (encoded), the rest of a GET in the query", () => {
    const { url, payload } = buildRequest(getTool, {
      id: ID,
      part: "a b/c",
      kind: ["x", "y"],
      ids: ["1", "2"],
      limit: 5,
      open: true,
    });
    // kind is a repeated parameter, ids (commaKeys) one comma-separated value
    expect(url).toBe(`/api/v1/things/${ID}/parts/a%20b%2Fc?kind=x&kind=y&ids=1%2C2&limit=5&open=true`);
    expect(payload).toBeUndefined();
  });

  it("sends the rest of a PATCH as JSON, except declared query keys", () => {
    const { url, payload } = buildRequest(patchTool, { id: ID, title: "New", dry: true });
    expect(url).toBe(`/api/v1/things/${ID}?dry=true`);
    expect(JSON.parse(payload!)).toEqual({ title: "New" });
  });

  it("always sends a JSON body for POST/PATCH, even an empty one", () => {
    expect(buildRequest(patchTool, { id: ID }).payload).toBe("{}");
  });

  it("refuses a call that lacks a path parameter", () => {
    expect(() => buildRequest(getTool, { id: ID })).toThrow(BridgeError);
  });

  it("finds path parameter names", () => {
    expect(pathParamNames("/a/:id/b/:cid")).toEqual(["id", "cid"]);
  });
});

describe("errorText", () => {
  it("reads Nest messages, message lists and zod flatten() bodies", () => {
    expect(errorText(409, { statusCode: 409, message: "Page changed since it was read" })).toBe(
      "HTTP 409: Page changed since it was read",
    );
    expect(errorText(400, { message: ["a is bad", "b is bad"] })).toBe("HTTP 400: a is bad; b is bad");
    expect(errorText(400, { formErrors: [], fieldErrors: { title: ["Required"] } })).toBe("HTTP 400: title: Required");
    expect(errorText(403, { message: "Missing permissions: tickets:admin" })).toBe(
      "Not allowed: Missing permissions: tickets:admin",
    );
    expect(errorText(401, { message: "Invalid or expired API token" })).toBe("Not signed in: Invalid or expired API token");
    expect(errorText(404, undefined)).toBe("Not found");
  });
});

describe("capResult", () => {
  it("leaves a result that fits alone", () => {
    const v = { a: 1 };
    expect(capResult(v, 1000)).toBe(v);
  });

  it("cuts a list to what fits and says how much was left out", () => {
    const list = Array.from({ length: 500 }, (_, i) => ({ i, text: "x".repeat(50) }));
    const out = capResult(list, 5000) as { truncated: boolean; total: number; shown: number; items: unknown[] };
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(500);
    expect(out.shown).toBe(out.items.length);
    expect(out.shown).toBeGreaterThan(0);
    expect(JSON.stringify(out, null, 2).length).toBeLessThan(5400);
  });

  it("cuts the biggest list inside an object and keeps the rest", () => {
    const v = { hits: Array.from({ length: 300 }, (_, i) => ({ i, t: "y".repeat(40) })), took: 12 };
    const out = capResult(v, 4000) as { took: number; hits: unknown[]; truncated: boolean };
    expect(out.took).toBe(12);
    expect(out.truncated).toBe(true);
    expect(out.hits.length).toBeLessThan(300);
  });

  it("cuts a long string", () => {
    const out = capResult("z".repeat(10_000), 1000) as { truncated: boolean; text: string };
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(1000);
  });
});

describe("tool schemas", () => {
  it("are plain JSON Schema generated from the zod input, strict", () => {
    const schema = toInputSchema(getTool) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["id", "part"]);
    expect(schema).not.toHaveProperty("$schema");
    expect(JSON.stringify(schema)).not.toContain("$ref");
  });

  it("reject unknown arguments", () => {
    expect(strictInput(getTool).safeParse({ id: ID, part: "p", nope: 1 }).success).toBe(false);
  });
});

describe("ApiBridge.call", () => {
  function bridge(respond: (opts: Record<string, unknown>) => { statusCode: number; body: string }) {
    const seen: Array<Record<string, unknown>> = [];
    const host = {
      httpAdapter: {
        getInstance: () => ({
          inject: async (opts: Record<string, unknown>) => (seen.push(opts), respond(opts)),
        }),
      },
    } as unknown as HttpAdapterHost;
    const settings = { publicBaseUrl: async () => "https://dash.example.org" } as unknown as SettingsService;
    return { b: new ApiBridge(host, settings), seen };
  }
  const caller: BridgeCaller = { authorization: "Bearer cdt_abc", ip: "10.1.2.3", readYourWrites: "77" };

  it("calls the route as the caller: their bearer, address and read-your-writes cookie", async () => {
    const { b, seen } = bridge(() => ({ statusCode: 200, body: JSON.stringify({ id: ID, title: "x" }) }));
    const out = (await b.call(patchTool, { id: ID, title: "x" }, caller)) as Record<string, unknown>;
    expect(seen[0]).toMatchObject({
      method: "PATCH",
      url: `/api/v1/things/${ID}`,
      remoteAddress: "10.1.2.3",
      payload: JSON.stringify({ title: "x" }),
    });
    expect(seen[0]!.headers).toMatchObject({
      authorization: "Bearer cdt_abc",
      "content-type": "application/json",
      cookie: "church_rv=77",
    });
    expect(out.url).toBe(`https://dash.example.org/things/${ID}`);
  });

  it("turns an error status into a BridgeError with the API's message", async () => {
    const { b } = bridge(() => ({ statusCode: 403, body: JSON.stringify({ message: "This API token is read-only" }) }));
    await expect(b.call(patchTool, { id: ID }, caller)).rejects.toThrow("Not allowed: This API token is read-only");
  });

  it("answers { ok: true } for an empty success", async () => {
    const { b } = bridge(() => ({ statusCode: 200, body: "" }));
    await expect(b.call(getTool, { id: ID, part: "p" }, caller)).resolves.toEqual({ ok: true });
  });
});
