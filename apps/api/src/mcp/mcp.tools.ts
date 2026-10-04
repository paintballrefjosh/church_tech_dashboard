import { Injectable, HttpException } from "@nestjs/common";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PERMISSIONS, wikiPageListQuerySchema } from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { recordAuditEntry } from "../audit/audit.decorator";
import { SettingsService } from "../settings/settings.service";
import { WikiService } from "../wiki/wiki.service";
import { WikiWritesService } from "../wiki/wiki-writes.service";
import { WikiFoldersService } from "../wiki/wiki-folders.service";

const SERVER_INFO = { name: "church-dashboard", version: "1.0.0" };

const INSTRUCTIONS = `Church Dashboard wiki. Use it to document the systems and services you work on.
- Before writing, use wiki_tree (or wiki_search) to find where a page belongs and whether one already exists; prefer updating an existing page over creating a duplicate.
- Page bodies are Markdown. Mermaid code blocks render as diagrams.
- To edit, call wiki_get_page first and pass its updatedAt as expectedUpdatedAt to wiki_update_page. If the page changed meanwhile the update is refused: re-read it and apply your edit to the new version.
- Every edit is kept as a revision a person can revert. There is no delete tool.`;

interface ToolContext {
  user: AuthenticatedUser;
  /** The HTTP request, for recording audit entries. */
  req: object;
}

interface ToolDef {
  tool: Tool;
  /** Permission the user (and later, the token) must hold to call the tool. */
  permission: string;
  args: z.ZodTypeAny;
  run: (ctx: ToolContext, args: never) => Promise<unknown>;
}

const uuid = z.string().uuid();

/**
 * The MCP tools: a thin layer over the same wiki services the REST routes
 * use, so permissions, page ACLs, revisions, search indexing, realtime and
 * notifications all behave exactly as they do in the web UI. Each request
 * builds a fresh low-level SDK `Server` bound to the caller (stateless
 * transport). Tool inputs are validated with zod here; the SDK only sees the
 * JSON Schemas below.
 */
@Injectable()
export class McpToolsService {
  private readonly defs: ToolDef[];

  constructor(
    private readonly wiki: WikiService,
    private readonly writes: WikiWritesService,
    private readonly folders: WikiFoldersService,
    private readonly settings: SettingsService,
  ) {
    this.defs = this.buildDefs();
  }

  /** Tool names, for tests and docs. */
  toolNames(): string[] {
    return this.defs.map((d) => d.tool.name);
  }

  createServer(ctx: ToolContext): Server {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.defs.map((d) => d.tool) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.call(ctx, request.params.name, request.params.arguments ?? {}),
    );
    return server;
  }

  async call(ctx: ToolContext, name: string, rawArgs: unknown): Promise<CallToolResult> {
    const def = this.defs.find((d) => d.tool.name === name);
    if (!def) return toolError(`Unknown tool: ${name}`);
    // A read-only token reaches this POST endpoint (it multiplexes reads and
    // writes), so its writes are refused here, per tool.
    if (ctx.user.apiToken?.readOnly && def.tool.annotations?.readOnlyHint !== true) {
      return toolError(`Not allowed: ${name} changes the wiki, and this API token is read-only.`);
    }
    // For a token, permissions are already narrowed to its modules.
    if (!ctx.user.permissions.includes(def.permission)) {
      return toolError(`Not allowed: ${name} needs the "${def.permission}" permission.`);
    }
    const parsed = def.args.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
      return toolError(`Invalid arguments: ${issues.join("; ")}`);
    }
    try {
      const result = await def.run(ctx, parsed.data as never);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return toolError(describeError(err));
    }
  }

  private async pageUrl(id: string): Promise<string> {
    return `${await this.settings.publicBaseUrl()}/wiki/${id}`;
  }

  private buildDefs(): ToolDef[] {
    const searchArgs = z
      .object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(10),
      })
      .strict();
    const idArgs = z.object({ id: uuid }).strict();
    const createArgs = z
      .object({
        title: z.string().trim().min(1).max(200),
        body: z.string().max(200_000).default(""),
        parentFolderId: uuid.optional(),
        parentId: uuid.optional(),
      })
      .strict()
      .refine((v) => !(v.parentFolderId && v.parentId), {
        message: "Give a parent folder or a parent page, not both",
      });
    const updateArgs = z
      .object({
        id: uuid,
        expectedUpdatedAt: z.string().datetime({ offset: true }),
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().max(200_000).optional(),
        summary: z.string().max(500).optional(),
        parentFolderId: uuid.nullable().optional(),
        parentId: uuid.nullable().optional(),
      })
      .strict()
      .refine((v) => !(v.parentFolderId && v.parentId), {
        message: "Give a parent folder or a parent page, not both",
      })
      .refine(
        (v) =>
          v.title !== undefined || v.body !== undefined || v.parentFolderId !== undefined || v.parentId !== undefined,
        { message: "Nothing to change: give a title, body, or new location" },
      );
    const folderArgs = z
      .object({ name: z.string().trim().min(1).max(200), parentFolderId: uuid.optional() })
      .strict();

    return [
      {
        tool: {
          name: "wiki_search",
          description:
            "Search wiki pages you can read by words in the title or body. Returns id, title, a snippet around the first match, updatedAt and a link, newest first.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 200, description: "Text to look for" },
              limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
            required: ["query"],
            additionalProperties: false,
          },
          annotations: { title: "Search wiki", readOnlyHint: true, openWorldHint: false },
        },
        permission: PERMISSIONS.WIKI_READ_OWN,
        args: searchArgs,
        run: async (ctx, a: z.infer<typeof searchArgs>) => {
          const rows = await this.wiki.list(ctx.user, wikiPageListQuerySchema.parse({ q: a.query, limit: a.limit }));
          return Promise.all(
            rows.map(async (p) => ({
              id: p.id,
              title: p.title,
              snippet: snippet(p.body, a.query),
              updatedAt: p.updatedAt,
              url: await this.pageUrl(p.id),
            })),
          );
        },
      },
      {
        tool: {
          name: "wiki_get_page",
          description:
            "Read one wiki page: title, Markdown body, location, visibility, whether you can edit it, and updatedAt (pass it to wiki_update_page).",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
            additionalProperties: false,
          },
          annotations: { title: "Read wiki page", readOnlyHint: true, openWorldHint: false },
        },
        permission: PERMISSIONS.WIKI_READ_OWN,
        args: idArgs,
        run: async (ctx, a: z.infer<typeof idArgs>) => {
          const { page, canEdit, updatedBy } = await this.wiki.getWithAcl(ctx.user, a.id);
          return {
            id: page.id,
            title: page.title,
            body: page.body,
            visibility: page.visibility,
            parentId: page.parentId,
            parentFolderId: page.parentFolderId,
            canEdit,
            updatedAt: page.updatedAt,
            updatedBy: updatedBy?.name ?? updatedBy?.email ?? null,
            url: await this.pageUrl(page.id),
          };
        },
      },
      {
        tool: {
          name: "wiki_tree",
          description:
            "The wiki's folders and pages you can read, as a flat list. Each node names its parent folder (parentFolderId) or parent page (parentId); both null means top level.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { title: "Wiki tree", readOnlyHint: true, openWorldHint: false },
        },
        permission: PERMISSIONS.WIKI_READ_OWN,
        args: z.object({}).strict(),
        run: async (ctx) => this.wiki.tree(ctx.user),
      },
      {
        tool: {
          name: "wiki_list_revisions",
          description: "A page's edit history, newest first: who, when and the edit summary (bodies omitted).",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", format: "uuid" } },
            required: ["id"],
            additionalProperties: false,
          },
          annotations: { title: "Page history", readOnlyHint: true, openWorldHint: false },
        },
        permission: PERMISSIONS.WIKI_READ_OWN,
        args: idArgs,
        run: async (ctx, a: z.infer<typeof idArgs>) => {
          const revs = await this.wiki.revisions(ctx.user, a.id);
          return revs.map((r) => ({
            id: r.id,
            title: r.title,
            summary: r.summary,
            editor: r.editorName ?? r.editorEmail,
            createdAt: r.createdAt,
          }));
        },
      },
      {
        tool: {
          name: "wiki_create_page",
          description:
            "Create a wiki page visible to everyone who can read the wiki. Put it in a folder (parentFolderId) or under another page (parentId), or omit both for the top level. Check wiki_tree / wiki_search first so you don't duplicate an existing page.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, maxLength: 200 },
              body: { type: "string", maxLength: 200000, description: "Markdown" },
              parentFolderId: { type: "string", format: "uuid" },
              parentId: { type: "string", format: "uuid" },
            },
            required: ["title"],
            additionalProperties: false,
          },
          annotations: { title: "Create wiki page", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        permission: PERMISSIONS.WIKI_CREATE,
        args: createArgs,
        run: async (ctx, a: z.infer<typeof createArgs>) => {
          const page = await this.writes.createPage(ctx.user, {
            title: a.title,
            body: a.body,
            visibility: "public",
            acl: [],
            parentFolderId: a.parentFolderId ?? null,
            parentId: a.parentId ?? null,
          });
          recordAuditEntry(ctx.req, { action: "wiki.create", resourceType: "wiki_page", resourceId: page.id, after: page });
          return { id: page.id, title: page.title, updatedAt: page.updatedAt, url: await this.pageUrl(page.id) };
        },
      },
      {
        tool: {
          name: "wiki_update_page",
          description:
            "Change a page's title, Markdown body and/or location. expectedUpdatedAt must be the updatedAt you last read with wiki_get_page; if the page changed since, the update is refused so you don't overwrite someone else's edit. The body replaces the whole existing body. Give a short summary of what changed.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              expectedUpdatedAt: { type: "string", format: "date-time" },
              title: { type: "string", minLength: 1, maxLength: 200 },
              body: { type: "string", maxLength: 200000, description: "Markdown; replaces the whole body" },
              summary: { type: "string", maxLength: 500, description: "Edit summary shown in the page history" },
              parentFolderId: { type: ["string", "null"], format: "uuid" },
              parentId: { type: ["string", "null"], format: "uuid" },
            },
            required: ["id", "expectedUpdatedAt"],
            additionalProperties: false,
          },
          annotations: {
            title: "Update wiki page",
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        permission: PERMISSIONS.WIKI_READ_OWN,
        args: updateArgs,
        run: async (ctx, a: z.infer<typeof updateArgs>) => {
          const { id, expectedUpdatedAt, ...changes } = a;
          const page = await this.writes.updatePage(ctx.user, id, changes, {
            expectedUpdatedAt: new Date(expectedUpdatedAt),
          });
          recordAuditEntry(ctx.req, { action: "wiki.update", resourceType: "wiki_page", resourceId: page.id, after: page });
          return { id: page.id, title: page.title, updatedAt: page.updatedAt, url: await this.pageUrl(page.id) };
        },
      },
      {
        tool: {
          name: "wiki_create_folder",
          description: "Create a folder to group pages, optionally inside another folder.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              parentFolderId: { type: "string", format: "uuid" },
            },
            required: ["name"],
            additionalProperties: false,
          },
          annotations: { title: "Create wiki folder", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        permission: PERMISSIONS.WIKI_CREATE,
        args: folderArgs,
        run: async (ctx, a: z.infer<typeof folderArgs>) => {
          const folder = await this.folders.create({ name: a.name, parentFolderId: a.parentFolderId ?? null });
          recordAuditEntry(ctx.req, {
            action: "wiki_folder.create",
            resourceType: "wiki_folder",
            resourceId: folder.id,
            after: folder,
          });
          return folder;
        },
      },
    ];
  }
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Turn a Nest HttpException (or anything else) into one readable line. */
export function describeError(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === "string") return res;
    const msg = (res as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    if (Array.isArray(msg)) return msg.join("; ");
    return JSON.stringify(res);
  }
  return err instanceof Error ? err.message : String(err);
}

/** ~240 characters of body around the first case-insensitive match. */
export function snippet(body: string, query: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 240);
  const start = Math.max(0, at - 100);
  const end = Math.min(flat.length, at + query.length + 140);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
