import { Client } from "minio";
import { resolveS3Config, type S3Config } from "./s3.config";

let cached: { client: Client; bucket: string; config: S3Config } | null = null;

/**
 * Lazy S3 client. We don't connect at import time so the api can boot in
 * environments where the object store isn't reachable yet (e.g. running migrations
 * against a remote DB without the rest of the compose stack). First call wires it up.
 * Settings are described in s3.config.ts.
 */
export function getS3(): { client: Client; bucket: string; config: S3Config } {
  if (cached) return cached;
  const config = resolveS3Config();
  const client = new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    sessionToken: config.sessionToken,
    region: config.region,
    pathStyle: config.pathStyle,
  });
  cached = { client, bucket: config.bucket, config };
  return cached;
}
