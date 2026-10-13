import type { z } from "zod";

/**
 * What a tool does to the world, which decides who may call it:
 *  - `read`: changes nothing (any token).
 *  - `write`: changes records in the dashboard (a token that is not read-only).
 *  - `operational`: acts on live equipment or services outside the dashboard
 *    (a switch port, a DNS record, a projector screen). Needs the
 *    "operational" token level (phase 3).
 */
export type ToolClass = "read" | "write" | "operational";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A tool that is a thin, typed door onto one existing REST route. The bridge
 * calls the route in-process with the caller's own bearer token, so guards,
 * token limits, audit, notifications, realtime and search indexing all run
 * exactly as they do for the web app. Nothing about the route is re-implemented.
 */
export interface BridgeTool {
  /** snake_case, `<area>_<verb>_<thing>`; unique; 64 characters at most. */
  name: string;
  /** Short title shown by clients. */
  title: string;
  /** What it does and what it returns; tell the model when to use it. */
  description: string;
  cls: ToolClass;
  method: HttpMethod;
  /** Route path without `/api/v1`, exactly as the controller declares it (`/tickets/:id`). */
  path: string;
  /**
   * The permissions the route's `@RequirePermissions` asks for. Used only to
   * hide tools the caller cannot use; the route's guard is what enforces them
   * (a test keeps this equal to the decorator).
   */
  permissions: string[];
  /**
   * The tool's arguments, flat: path parameters, query parameters and body
   * fields side by side. Reuse the Zod schema the route validates with where
   * there is one. Path parameters are taken from the keys named in `path`; for
   * a GET the rest goes in the query string, otherwise in the JSON body.
   */
  input: z.ZodObject<z.ZodRawShape>;
  /** Non-GET tools only: argument names that go in the query string instead of the body. */
  queryKeys?: string[];
  /**
   * Array arguments the route reads as one comma-separated query value (`?kind=a,b`). Every other
   * array in the query is repeated (`?status=a&status=b`), which is what Fastify turns into an array.
   */
  commaKeys?: string[];
  /** Write/operational tools: the call removes or overwrites something that cannot be put back. */
  destructive?: boolean;
  /** Repeating the same call with the same arguments has no further effect. */
  idempotent?: boolean;
  /** A web path (`/tickets/<id>`) for a result, shown to the model as an absolute `url`. */
  link?: (result: unknown) => string | null;
}

export function defineTool(tool: BridgeTool): BridgeTool {
  return tool;
}

/** The route parameter names of a path template: `/a/:id/b/:cid` gives `["id", "cid"]`. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}
