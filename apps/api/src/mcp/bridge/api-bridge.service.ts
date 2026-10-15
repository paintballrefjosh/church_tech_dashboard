import { Injectable } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { FastifyInstance } from "fastify";
import { HIDDEN } from "../../audit/audit-scrub";
import { SettingsService } from "../../settings/settings.service";
import { pathParamNames, type BridgeTool } from "./bridge.types";
import { downloadContent, filenameFromDisposition, multipartFile, uploadBytes, type UploadArgs } from "./attachments";

/** The parts of the incoming MCP request the route call must carry on. */
export interface BridgeCaller {
  /** The `Authorization: Bearer` header, verbatim. The route re-judges the token itself. */
  authorization: string;
  /** The client address, so the per-IP rate limit and the audit row see the real one. */
  ip: string | null;
  /** The read-your-writes cookie of a cluster, if the client sent one. */
  readYourWrites: string | null;
}

/** A route answered with an error status. The message is what the model is shown. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Largest result handed back, in characters of JSON (a model's context is the limit, not the network). */
export const MAX_RESULT_CHARS = 60_000;

const API_PREFIX = "/api/v1";

/**
 * Calls the API's own routes in-process (Fastify `inject`), as the caller.
 *
 * Why not call the services: the controllers do real work around them (realtime
 * events, "assigned to you" notifications, search updates), and the guards,
 * the audit interceptor, the restore gate and the token limits sit on the route.
 * Going through the route means a tool can never do something the web app could
 * not, and never skips something the web app does.
 */
@Injectable()
export class ApiBridge {
  constructor(
    private readonly host: HttpAdapterHost,
    private readonly settings: SettingsService,
  ) {}

  private get app(): FastifyInstance {
    return this.host.httpAdapter.getInstance() as FastifyInstance;
  }

  async call(tool: BridgeTool, args: Record<string, unknown>, caller: BridgeCaller): Promise<unknown> {
    if (tool.binary === "download") return this.download(tool, args, caller);

    let request: { url: string; payload: string | Buffer | undefined } = buildRequest(tool, args);
    let contentType = "application/json";
    if (tool.binary === "upload") {
      const { filename, contentType: declared, text, contentBase64, ...params } = args;
      const file = uploadBytes({ filename, contentType: declared, text, contentBase64 } as UploadArgs);
      const multipart = multipartFile(String(filename), file.contentType, file.bytes);
      request = { url: buildRequest(tool, params).url, payload: multipart.body };
      contentType = `multipart/form-data; boundary=${multipart.boundary}`;
    }
    const res = await this.send(tool, request.url, request.payload, contentType, caller);

    let body: unknown = undefined;
    if (res.body) {
      try {
        body = JSON.parse(res.body);
      } catch {
        body = res.body;
      }
    }
    if (res.statusCode >= 400) throw new BridgeError(res.statusCode, errorText(res.statusCode, body));

    let result: unknown = body === undefined || body === "" ? { ok: true } : body;
    if (tool.redact?.length) result = redactKeys(result, tool.redact);
    if (tool.transform) result = tool.transform(result);
    if (tool.link) {
      const path = tool.link(result);
      if (path && result && typeof result === "object" && !Array.isArray(result)) {
        result = { ...(result as Record<string, unknown>), url: `${await this.settings.publicBaseUrl()}${path}` };
      }
    }
    return capResult(result);
  }

  /** A GET that streams a file: described, and handed over where a model can read it (images, text). */
  private async download(tool: BridgeTool, args: Record<string, unknown>, caller: BridgeCaller) {
    const { url } = buildRequest(tool, args);
    const res = await this.send(tool, url, undefined, "application/json", caller);
    if (res.statusCode >= 400) {
      let body: unknown = res.body;
      try {
        body = JSON.parse(res.body);
      } catch {
        /* a plain-text error */
      }
      throw new BridgeError(res.statusCode, errorText(res.statusCode, body));
    }
    return downloadContent({
      filename: filenameFromDisposition(res.headers["content-disposition"] as string | undefined),
      contentType: String(res.headers["content-type"] ?? "application/octet-stream"),
      bytes: res.rawPayload,
    });
  }

  /** One in-process request to a route, carrying the caller's token, address and read-your-writes cookie. */
  private send(tool: BridgeTool, url: string, payload: string | Buffer | undefined, contentType: string, caller: BridgeCaller) {
    const headers: Record<string, string> = {
      authorization: caller.authorization,
      accept: tool.binary === "download" ? "*/*" : "application/json",
      "user-agent": "church-dashboard-mcp",
    };
    if (payload !== undefined) headers["content-type"] = contentType;
    if (caller.readYourWrites) headers.cookie = `church_rv=${caller.readYourWrites}`;
    return this.app.inject({
      method: tool.method,
      url,
      headers,
      payload,
      ...(caller.ip ? { remoteAddress: caller.ip } : {}),
    });
  }
}

/** Turn a tool's flat arguments into the route's URL and JSON body. */
export function buildRequest(
  tool: BridgeTool,
  args: Record<string, unknown>,
): { url: string; payload: string | undefined } {
  const params = new Set(pathParamNames(tool.path));
  const queryKeys = new Set(tool.queryKeys ?? []);
  const commaKeys = new Set(tool.commaKeys ?? []);
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (params.has(key)) {
      values[key] = String(value);
    } else if (tool.method === "GET" || queryKeys.has(key)) {
      if (value === null) continue;
      if (Array.isArray(value)) {
        if (commaKeys.has(key)) query.set(key, value.join(","));
        else for (const item of value) query.append(key, String(item));
      } else {
        query.set(key, String(value));
      }
    } else {
      body[key] = value;
    }
  }

  const path = tool.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new BridgeError(400, `Missing argument: ${name}`);
    return encodeURIComponent(v);
  });
  const qs = query.toString();
  const url = `${API_PREFIX}${path}${qs ? `?${qs}` : ""}`;
  const hasBody = tool.method !== "GET" && tool.method !== "DELETE" ? true : Object.keys(body).length > 0;
  return { url, payload: hasBody ? JSON.stringify(body) : undefined };
}

export { HIDDEN };

/** Replace the value of the named keys, at any depth, with `[hidden]` (null and empty values stay, so "none set" still reads). */
export function redactKeys(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => redactKeys(v, keys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(k) && v !== null && v !== undefined && v !== "") out[k] = HIDDEN;
      else out[k] = redactKeys(v, keys);
    }
    return out;
  }
  return value;
}

/** One readable line for the model out of whatever shape the API answered with. */
export function errorText(status: number, body: unknown): string {
  let detail: string | undefined;
  if (typeof body === "string") {
    detail = body;
  } else if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string") detail = b.message;
    else if (Array.isArray(b.message)) detail = b.message.join("; ");
    else if (b.fieldErrors && typeof b.fieldErrors === "object") {
      // A zod `flatten()` passed straight to BadRequestException.
      const parts = Object.entries(b.fieldErrors as Record<string, unknown>).map(
        ([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`,
      );
      const form = Array.isArray(b.formErrors) ? (b.formErrors as unknown[]).map(String) : [];
      detail = [...form, ...parts].join("; ");
    }
  }
  const text = (detail && detail.trim()) || (body !== undefined ? JSON.stringify(body) : "");
  const label =
    status === 401 ? "Not signed in" : status === 403 ? "Not allowed" : status === 404 ? "Not found" : `HTTP ${status}`;
  return text ? `${label}: ${text.slice(0, 500)}` : label;
}

/**
 * Keep a result inside what a model can read. A list is cut to the items that
 * fit, with the total and a hint to narrow the query; anything else is cut as
 * text. A result that already fits is returned untouched.
 */
export function capResult(value: unknown, max = MAX_RESULT_CHARS): unknown {
  const size = (v: unknown) => JSON.stringify(v, null, 2).length;
  if (size(value) <= max) return value;

  const note = "Result too large to return in full: narrow it with filters, or ask for fewer items.";
  const cutList = (list: unknown[], wrap: (items: unknown[]) => Record<string, unknown>) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(wrap(list.slice(0, mid))) <= max) lo = mid;
      else hi = mid - 1;
    }
    return { truncated: true, total: list.length, shown: lo, note, ...wrap(list.slice(0, lo)) };
  };

  if (Array.isArray(value)) return cutList(value, (items) => ({ items }));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Cut the biggest list inside it; the rest of the object stays whole.
    const biggest = Object.entries(obj)
      .filter(([, v]) => Array.isArray(v))
      .sort((a, b) => size(b[1]) - size(a[1]))[0];
    if (biggest) {
      const [key, list] = biggest as [string, unknown[]];
      const rest = { ...obj };
      delete rest[key];
      return cutList(list, (items) => ({ ...rest, [key]: items }));
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { truncated: true, total: text.length, shown: max, note, text: text.slice(0, max) };
}
