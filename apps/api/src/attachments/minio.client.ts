import { Client } from "minio";

let cached: { client: Client; bucket: string } | null = null;

/**
 * Lazy MinIO client. We don't connect at import time so the api can boot in
 * environments where MinIO isn't reachable yet (e.g. running migrations against
 * a remote DB without the rest of the compose stack). First call wires it up.
 *
 * All env vars are mandatory; the compose stack sets sensible defaults.
 */
export function getMinio(): { client: Client; bucket: string } {
  if (cached) return cached;
  const endpoint = process.env.MINIO_ENDPOINT ?? "minio:9000";
  const accessKey = process.env.MINIO_ROOT_USER;
  const secretKey = process.env.MINIO_ROOT_PASSWORD;
  const bucket = process.env.MINIO_BUCKET ?? "church-files";
  if (!accessKey || !secretKey) {
    throw new Error("MINIO_ROOT_USER + MINIO_ROOT_PASSWORD must be set");
  }
  const [host, portStr] = endpoint.split(":");
  if (!host) throw new Error("MINIO_ENDPOINT must be host:port");
  const port = portStr ? Number(portStr) : undefined;
  const useSSL = process.env.MINIO_USE_SSL === "true";
  const client = new Client({
    endPoint: host,
    port,
    useSSL,
    accessKey,
    secretKey,
    region: process.env.MINIO_REGION ?? "us-east-1",
  });
  cached = { client, bucket };
  return cached;
}
