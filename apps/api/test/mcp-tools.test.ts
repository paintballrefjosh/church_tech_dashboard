import "reflect-metadata";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PERMISSIONS } from "@church/shared";
import { AUDIT_ENTRIES_KEY, type DynamicAuditEntry } from "../src/audit/audit.decorator";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";
import { McpToolsService, snippet, describeError } from "../src/mcp/mcp.tools";
import type { WikiService } from "../src/wiki/wiki.service";
import type { WikiWritesService } from "../src/wiki/wiki-writes.service";
import type { WikiFoldersService } from "../src/wiki/wiki-folders.service";
import type { SettingsService } from "../src/settings/settings.service";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const FOLDER_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED = new Date("2026-10-04T10:00:00.000Z");

function user(permissions: string[]): AuthenticatedUser {
  return {
    id: "u1",
    email: "claude-docs@local",
    name: "Claude (docs)",
    isActive: true,
    totpEnabled: false,
    mustChangePassword: false,
    approvalStatus: "approved",
    groups: ["docs"],
    permissions,
    access: { wiki: "user" },
  };
}

const page = {
  id: PAGE_ID,
  title: "DNS",
  body: "# DNS\n\nTechnitium cluster with two nodes. The primary takes edits.",
  visibility: "public",
  parentId: null,
  parentFolderId: FOLDER_ID,
  ownerUserId: "u1",
  createdAt: UPDATED,
  updatedAt: UPDATED,
};

/** Stub services recording what the tools asked for. */
function build() {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const wiki = {
    list: async (_u: unknown, q: unknown) => (rec("list", q), [page]),
    getWithAcl: async () => ({ page, acl: [], canEdit: true, canDelete: false, updatedBy: { name: "Josh", email: "j@x" } }),
    tree: async () => [{ kind: "folder", id: FOLDER_ID, name: "Systems", parentFolderId: null }],
    revisions: async () => [
      { id: "r1", pageId: PAGE_ID, title: "DNS", body: "long", editorUserId: "u1", editorName: null, editorEmail: "j@x", summary: "init", createdAt: UPDATED },
    ],
  };
  const writes = {
    createPage: async (_u: unknown, input: unknown) => (rec("createPage", input), { ...page, id: "33333333-3333-4333-8333-333333333333" }),
    updatePage: async (_u: unknown, id: string, input: unknown, opts: { expectedUpdatedAt?: Date }) => {
      rec("updatePage", id, input, opts);
      if (opts.expectedUpdatedAt?.getTime() !== UPDATED.getTime()) {
        throw new ConflictException("Page changed since it was read");
      }
      return { ...page, updatedAt: new Date("2026-10-04T11:00:00.000Z") };
    },
  };
  const folders = {
    create: async (input: unknown) => (rec("createFolder", input), { id: FOLDER_ID, name: "Systems", parentFolderId: null }),
  };
  const settings = { publicBaseUrl: async () => "https://dash.example.org" };
  const svc = new McpToolsService(
    wiki as unknown as WikiService,
    writes as unknown as WikiWritesService,
    folders as unknown as WikiFoldersService,
    settings as unknown as SettingsService,
  );
  return { svc, calls };
}

const READ_WRITE = [PERMISSIONS.WIKI_READ_OWN, PERMISSIONS.WIKI_CREATE];
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? "";

describe("McpToolsService.call", () => {
  it("exposes the seven wiki tools", () => {
    expect(build().svc.toolNames()).toEqual([
      "wiki_search",
      "wiki_get_page",
      "wiki_tree",
      "wiki_list_revisions",
      "wiki_create_page",
      "wiki_update_page",
      "wiki_create_folder",
    ]);
  });

  it("refuses a tool the user lacks the permission for", async () => {
    const { svc, calls } = build();
    const req = {};
    const r = await svc.call({ user: user([PERMISSIONS.WIKI_READ_OWN]), req }, "wiki_create_page", { title: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/wiki:create/);
    expect(calls.createPage).toBeUndefined();
  });

  it("lets a read-only token read but refuses its writes", async () => {
    const { svc, calls } = build();
    const ro: AuthenticatedUser = {
      ...user(READ_WRITE),
      apiToken: { id: "t1", name: "docs", readOnly: true, modules: ["wiki"] },
    };
    const read = await svc.call({ user: ro, req: {} }, "wiki_search", { query: "dns" });
    expect(read.isError).toBeFalsy();
    const write = await svc.call({ user: ro, req: {} }, "wiki_create_page", { title: "x" });
    expect(write.isError).toBe(true);
    expect(text(write)).toMatch(/read-only/);
    expect(calls.createPage).toBeUndefined();
  });

  it("rejects bad arguments with a readable message", async () => {
    const { svc } = build();
    const r = await svc.call({ user: user(READ_WRITE), req: {} }, "wiki_get_page", { id: "nope", extra: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/id/);
  });

  it("searches with snippets and absolute links", async () => {
    const { svc, calls } = build();
    const r = await svc.call({ user: user(READ_WRITE), req: {} }, "wiki_search", { query: "primary" });
    const rows = JSON.parse(text(r));
    expect(rows[0]).toMatchObject({ id: PAGE_ID, url: `https://dash.example.org/wiki/${PAGE_ID}` });
    expect(rows[0].snippet).toContain("primary takes edits");
    expect(calls.list?.[0]?.[0]).toMatchObject({ q: "primary", limit: 10 });
  });

  it("creates a public page and records one audit entry", async () => {
    const { svc, calls } = build();
    const req: { [AUDIT_ENTRIES_KEY]?: DynamicAuditEntry[] } = {};
    const r = await svc.call({ user: user(READ_WRITE), req }, "wiki_create_page", {
      title: "UPS",
      body: "# UPS",
      parentFolderId: FOLDER_ID,
    });
    expect(r.isError).toBeFalsy();
    expect(calls.createPage?.[0]?.[0]).toMatchObject({ visibility: "public", acl: [], parentFolderId: FOLDER_ID });
    expect(req[AUDIT_ENTRIES_KEY]?.map((e) => e.action)).toEqual(["wiki.create"]);
  });

  it("passes expectedUpdatedAt through and reports a conflict", async () => {
    const { svc, calls } = build();
    const req: { [AUDIT_ENTRIES_KEY]?: DynamicAuditEntry[] } = {};
    const stale = await svc.call({ user: user(READ_WRITE), req }, "wiki_update_page", {
      id: PAGE_ID,
      expectedUpdatedAt: "2026-10-04T09:00:00.000Z",
      body: "new",
    });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/changed since/);
    expect(req[AUDIT_ENTRIES_KEY]).toBeUndefined();

    const ok = await svc.call({ user: user(READ_WRITE), req }, "wiki_update_page", {
      id: PAGE_ID,
      expectedUpdatedAt: UPDATED.toISOString(),
      body: "new",
      summary: "tweak",
    });
    expect(ok.isError).toBeFalsy();
    expect(calls.updatePage?.[1]?.[1]).toEqual({ body: "new", summary: "tweak" });
    expect(req[AUDIT_ENTRIES_KEY]?.map((e) => e.action)).toEqual(["wiki.update"]);
  });

  it("refuses an update with nothing to change", async () => {
    const { svc } = build();
    const r = await svc.call({ user: user(READ_WRITE), req: {} }, "wiki_update_page", {
      id: PAGE_ID,
      expectedUpdatedAt: UPDATED.toISOString(),
      summary: "only a summary",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Nothing to change/);
  });

  it("reads never record audit entries", async () => {
    const { svc } = build();
    const req: { [AUDIT_ENTRIES_KEY]?: DynamicAuditEntry[] } = {};
    await svc.call({ user: user(READ_WRITE), req }, "wiki_get_page", { id: PAGE_ID });
    await svc.call({ user: user(READ_WRITE), req }, "wiki_tree", {});
    await svc.call({ user: user(READ_WRITE), req }, "wiki_list_revisions", { id: PAGE_ID });
    expect(req[AUDIT_ENTRIES_KEY]).toBeUndefined();
  });
});

describe("helpers", () => {
  it("snippet centres on the match", () => {
    const body = `${"x ".repeat(200)}needle ${"y ".repeat(200)}`;
    const s = snippet(body, "NEEDLE");
    expect(s.startsWith("…")).toBe(true);
    expect(s).toContain("needle");
    expect(s.length).toBeLessThan(260);
  });

  it("describeError unwraps Nest exceptions", () => {
    expect(describeError(new ForbiddenException("Cannot edit this page"))).toBe("Cannot edit this page");
  });
});

// The real protocol, end to end: the SDK's own client against our tools over
// HTTP, with the same stateless JSON transport settings as McpController.
describe("over Streamable HTTP", () => {
  let http: HttpServer;
  let url: URL;

  beforeAll(async () => {
    const { svc } = build();
    http = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const server = svc.createServer({ user: user(READ_WRITE), req: {} });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  });

  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
  });

  it("initializes, lists tools, and calls one", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect(client.getServerVersion()?.name).toBe("church-dashboard");
    expect(client.getInstructions()).toMatch(/expectedUpdatedAt/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("wiki_update_page");
    expect(tools.find((t) => t.name === "wiki_search")?.annotations?.readOnlyHint).toBe(true);

    const res = await client.callTool({ name: "wiki_get_page", arguments: { id: PAGE_ID } });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({ title: "DNS", canEdit: true });

    const bad = await client.callTool({ name: "wiki_get_page", arguments: { id: "nope" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
