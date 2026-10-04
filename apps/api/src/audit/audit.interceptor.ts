import {
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { tap } from "rxjs/operators";
import type { Observable } from "rxjs";
import { AuditService } from "./audit.service";
import { AUDIT_KEY, SKIP_AUDIT_KEY, type AuditMeta } from "./audit.decorator";
import type { AuthenticatedUser } from "../auth/current-user.decorator";

const METHOD_VERB: Record<string, string> = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

/**
 * Audit every mutating request by default. Explicit @Audited gives a nice
 * "user.create"-style action name and a captured response body; routes
 * without one still get a row with a derived action so nothing slips
 * through. @SkipAudit opts out for high-volume reads-pretending-to-be-writes
 * (notification mark-read etc).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const method: string = (req.method ?? "GET").toUpperCase();

    // GET/HEAD/OPTIONS are reads — never audited.
    if (!(method in METHOD_VERB)) return next.handle();

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return next.handle();

    const explicit = this.reflector.get<AuditMeta | undefined>(AUDIT_KEY, ctx.getHandler());
    const meta: AuditMeta = explicit ?? deriveMeta(method, req.url ?? "");

    const user: AuthenticatedUser | undefined = req.user;
    const ip: string | null = req.ip ?? req.headers?.["x-forwarded-for"] ?? null;
    const userAgent: string | null = req.headers?.["user-agent"] ?? null;
    const requestBody = req.body;

    return next.handle().pipe(
      tap((response) => {
        const resourceId =
          (typeof response === "object" && response !== null && "id" in response
            ? String((response as { id: unknown }).id)
            : null) ?? meta.resourceIdFromParams?.(req.params) ?? null;

        this.audit
          .write({
            actorUserId: user?.id ?? null,
            actorEmail: user?.email ?? null,
            action: meta.action,
            resourceType: meta.resourceType,
            resourceId,
            before: meta.captureBefore ? null : null,
            after: redact(meta.captureAfter ? response : requestBody ?? null, meta.redactKeys),
            ip: typeof ip === "string" ? ip : null,
            userAgent,
            apiTokenId: user?.apiToken?.id ?? null,
          })
          .catch(() => undefined);
      }),
    );
  }
}

/** Shallow copy of an object snapshot without the given keys. */
function redact(snapshot: unknown, keys: readonly string[] | undefined): unknown {
  if (!keys?.length || typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return snapshot;
  }
  const copy: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const k of keys) delete copy[k];
  return copy;
}

/**
 * Derive an action key and resource type from the HTTP method + URL when no
 * @Audited decorator is present. Example: `POST /api/v1/tickets/abc/comments`
 * becomes `{ action: "tickets.create", resourceType: "tickets" }`. Crude but
 * better than dropping the row entirely.
 */
function deriveMeta(method: string, url: string): AuditMeta {
  const path = url.split("?")[0] ?? "";
  const segments = path.replace(/^\/api\/v\d+\//, "").split("/").filter(Boolean);
  const resource = segments[0] ?? "unknown";
  const verb = METHOD_VERB[method] ?? method.toLowerCase();
  return { action: `${resource}.${verb}`, resourceType: resource, captureAfter: true };
}
