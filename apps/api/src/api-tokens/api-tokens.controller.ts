import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, apiTokenCreateSchema, apiTokenListQuerySchema, type ApiTokenCreate } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { ApiTokensService } from "./api-tokens.service";

const uuid = z.string().uuid();

function parseId(id: string): string {
  if (!uuid.safeParse(id).success) throw new BadRequestException("Invalid id");
  return id;
}

function parseCreate(body: unknown): ApiTokenCreate {
  const parsed = apiTokenCreateSchema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

const idParam = (p: Record<string, string>): string | null => p.id ?? null;

/**
 * A signed-in user's own tokens. Creating and revoking need a browser
 * session (@SessionOnly), so a leaked token can't mint its own replacement.
 * The create response carries the plaintext token once; `redactKeys` keeps
 * it out of the audit snapshot.
 */
@Controller("me/api-tokens")
export class MeApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.tokens.listForUser(user.id);
  }

  @Get("policy")
  policy() {
    return this.tokens.policy();
  }

  @Post()
  @SessionOnly()
  @Audited({ action: "api_token.create", resourceType: "api_token", redactKeys: ["token"] })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.tokens.createForSelf(user, parseCreate(body));
  }

  @Delete(":id")
  @SessionOnly()
  @Audited({ action: "api_token.revoke", resourceType: "api_token", resourceIdFromParams: idParam })
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.tokens.revoke(parseId(id), user.id);
  }
}

/** Every user's tokens, and tokens issued to service accounts. user:admin. */
@Controller("admin")
@RequirePermissions(PERMISSIONS.USER_ADMIN)
export class AdminApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get("api-tokens")
  list(@Query() query: unknown) {
    const parsed = apiTokenListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tokens.listAll(parsed.data);
  }

  @Delete("api-tokens/:id")
  @SessionOnly()
  @Audited({ action: "api_token.revoke", resourceType: "api_token", resourceIdFromParams: idParam })
  revoke(@Param("id") id: string) {
    return this.tokens.revoke(parseId(id));
  }

  /** Issue a token to another user, e.g. a passwordless "Claude (docs)" account. */
  @Post("users/:id/api-tokens")
  @SessionOnly()
  @Audited({ action: "api_token.create", resourceType: "api_token", redactKeys: ["token"] })
  issue(@Param("id") id: string, @Body() body: unknown) {
    return this.tokens.createForUser(parseId(id), parseCreate(body));
  }

  @Post("users/:id/api-tokens/revoke-all")
  @SessionOnly()
  @Audited({ action: "api_token.revoke_all", resourceType: "user", resourceIdFromParams: idParam })
  revokeAll(@Param("id") id: string) {
    return this.tokens.revokeAllForUser(parseId(id));
  }
}
