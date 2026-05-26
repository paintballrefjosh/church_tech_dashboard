import { SetMetadata } from "@nestjs/common";
import type { PermissionString } from "@church/shared";

export const REQUIRED_PERMISSIONS_KEY = "requiredPermissions";

/**
 * Gate a controller or handler on one or more permission strings. The user must
 * hold ALL listed permissions via at least one of their roles. Use the PERMISSIONS
 * constants from @church/shared to avoid typos.
 */
export const RequirePermissions = (...perms: PermissionString[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, perms);
