import { SIGNAGE_LIMITS } from "@church/shared";

/** A device that answered a poll this recently counts as online (polls run every minute). */
export const SIGNAGE_ONLINE_MS = SIGNAGE_LIMITS.offlineAfterMin * 60_000;
/** Where signage files live in the object store (never exposed through the proxy). */
export const SIGNAGE_S3_PREFIX = "signage/";
export const signageUploadKey = (id: string) => `signage/uploads/${id}`;
export const signageMediaKey = (sha: string, ext: string) => `signage/media/${sha}.${ext}`;
export const signageThumbKey = (sha: string) => `signage/thumbs/${sha}.jpg`;
export const signageReleaseKey = (version: string) => `signage/releases/signage-agent-${version}.tar.gz`;
