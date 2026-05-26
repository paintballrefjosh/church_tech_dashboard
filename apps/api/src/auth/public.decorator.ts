import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Routes decorated with @Public() bypass SessionGuard and PermissionsGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
