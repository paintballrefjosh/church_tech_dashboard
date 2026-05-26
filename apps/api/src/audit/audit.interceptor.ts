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
import { AUDIT_KEY, type AuditMeta } from "./audit.decorator";
import type { AuthenticatedUser } from "../auth/current-user.decorator";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_KEY, ctx.getHandler());
    if (!meta) return next.handle();

    const req = ctx.switchToHttp().getRequest();
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

        // fire-and-forget; errors only logged inside the service
        this.audit
          .write({
            actorUserId: user?.id ?? null,
            actorEmail: user?.email ?? null,
            action: meta.action,
            resourceType: meta.resourceType,
            resourceId,
            before: meta.captureBefore ? null : null, // controllers may attach via req for now
            after: meta.captureAfter ? response : requestBody ?? null,
            ip: typeof ip === "string" ? ip : null,
            userAgent,
          })
          .catch(() => undefined);
      })
    );
  }
}
