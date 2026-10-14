import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { REQUIRED_PERMISSIONS_KEY } from "../../auth/permissions.decorator";
import { SESSION_ONLY_KEY } from "../../auth/session-only.decorator";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";
import { OPERATIONAL_ONLY_KEY } from "../../auth/operational-only.decorator";

/** One HTTP route of the API, read from the Nest decorators on a controller. */
export interface RouteInfo {
  /** `GET /tickets/:id` (no /api/v1 prefix). The key tools and exclusions are matched on. */
  key: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  /** Everything `@RequirePermissions` asks for (class and method merged; the guard wants all of them). */
  permissions: string[];
  sessionOnly: boolean;
  /** `@OperationalOnly()`: a token needs the operational level. */
  operationalOnly: boolean;
  isPublic: boolean;
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
  [RequestMethod.ALL]: "ALL",
};

function joinPath(...parts: Array<string | string[] | undefined>): string {
  const segments: string[] = [];
  for (const part of parts) {
    const p = Array.isArray(part) ? part[0] : part;
    if (!p) continue;
    for (const s of p.split("/")) if (s) segments.push(s);
  }
  return "/" + segments.join("/");
}

/** Every route of the given controller classes. Needs no running app. */
export function listRoutes(controllers: Array<abstract new (...args: never[]) => unknown>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const cls of controllers) {
    const base = Reflect.getMetadata("path", cls) as string | string[] | undefined;
    if (base === undefined) continue; // not a @Controller
    const classPerms = (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, cls) as string[] | undefined) ?? [];
    const classSessionOnly = Reflect.getMetadata(SESSION_ONLY_KEY, cls) === true;
    const classOperational = Reflect.getMetadata(OPERATIONAL_ONLY_KEY, cls) === true;
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, cls) === true;
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      if (name === "constructor") continue;
      const fn = (cls.prototype as Record<string, unknown>)[name];
      if (typeof fn !== "function") continue;
      const methodId = Reflect.getMetadata("method", fn) as number | undefined;
      if (methodId === undefined) continue;
      const sub = Reflect.getMetadata("path", fn) as string | string[] | undefined;
      const method = METHOD_NAMES[methodId] ?? String(methodId);
      const path = joinPath(base, sub);
      const methodPerms = (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, fn) as string[] | undefined) ?? [];
      routes.push({
        key: `${method} ${path}`,
        method,
        path,
        controller: cls.name,
        handler: name,
        permissions: [...new Set([...classPerms, ...methodPerms])],
        sessionOnly: classSessionOnly || Reflect.getMetadata(SESSION_ONLY_KEY, fn) === true,
        operationalOnly: classOperational || Reflect.getMetadata(OPERATIONAL_ONLY_KEY, fn) === true,
        isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, fn) === true,
      });
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}
