import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import {
  PERMISSIONS,
  assetListQuerySchema,
  checkoutAssetSchema,
  createAssetSchema,
  importAssetsSchema,
  isoDateSchema,
  returnAssetSchema,
  updateAssetSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { AssetsService } from "./assets.service";
import { parseBody } from "./locations.controller";

export const setAssetDueSchema = z.object({ dueOn: isoDateSchema.nullable() }).strict();

/**
 * The inventory (docs/assets.md). Reading and checking out to yourself ride the Assets user tier; adding, editing,
 * checking out for others and the history need `assets:write:any`; deleting and importing `assets:admin`.
 */
@Controller("assets")
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ASSETS_READ_ANY)
  list(@Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.list(parseBody(assetListQuerySchema, query), user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ASSETS_WRITE_ANY)
  @Audited({ action: "asset.create", resourceType: "asset" })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.create(parseBody(createAssetSchema, body), user);
  }

  @Post("import")
  @RequirePermissions(PERMISSIONS.ASSETS_ADMIN)
  @Audited({ action: "asset.import", resourceType: "asset" })
  import(@Body() body: unknown) {
    return this.assets.import(parseBody(importAssetsSchema, body));
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.ASSETS_READ_ANY)
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.get(id, user);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.ASSETS_WRITE_ANY)
  @Audited({ action: "asset.update", resourceType: "asset", resourceIdFromParams: (p) => p.id ?? null })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.update(id, parseBody(updateAssetSchema, body), user);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.ASSETS_ADMIN)
  @Audited({ action: "asset.delete", resourceType: "asset", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.assets.remove(id);
    return { ok: true };
  }

  /** To yourself (Assets user tier), or to someone else (staff); the service decides which. */
  @Post(":id/checkout")
  @RequirePermissions(PERMISSIONS.ASSETS_READ_ANY)
  @Audited({ action: "asset.checkout", resourceType: "asset", resourceIdFromParams: (p) => p.id ?? null })
  checkout(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.checkout(id, parseBody(checkoutAssetSchema, body), user);
  }

  /** The holder, or staff. */
  @Post(":id/return")
  @RequirePermissions(PERMISSIONS.ASSETS_READ_ANY)
  @Audited({ action: "asset.return", resourceType: "asset", resourceIdFromParams: (p) => p.id ?? null })
  returnAsset(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.returnAsset(id, parseBody(returnAssetSchema, body), user);
  }

  @Put(":id/due")
  @RequirePermissions(PERMISSIONS.ASSETS_WRITE_ANY)
  @Audited({ action: "asset.due", resourceType: "asset", resourceIdFromParams: (p) => p.id ?? null })
  setDue(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.setDue(id, parseBody(setAssetDueSchema, body).dueOn, user);
  }

  @Get(":id/history")
  @RequirePermissions(PERMISSIONS.ASSETS_WRITE_ANY)
  history(@Param("id", ParseUUIDPipe) id: string) {
    return this.assets.history(id);
  }

  @Get(":id/tickets")
  @RequirePermissions(PERMISSIONS.ASSETS_READ_ANY)
  tickets(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.assets.tickets(id, user);
  }
}
