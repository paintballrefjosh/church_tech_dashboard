/**
 * Where uploaded files go: any S3-compatible object store (the bundled MinIO, a
 * cluster of Garage nodes, AWS S3, Backblaze B2, a MinIO you run yourself).
 *
 * Settings, newest name first with the old MinIO name as the fallback, so an existing
 * `.env` keeps working unchanged:
 *
 *   S3_ENDPOINT      host[:port] or a URL (`https://s3.example.org`); no path        MINIO_ENDPOINT   (minio:9000)
 *   S3_USE_SSL       true/false; default: https in the URL, otherwise false          MINIO_USE_SSL
 *   S3_REGION        default us-east-1                                               MINIO_REGION
 *   S3_BUCKET        default church-files                                            MINIO_BUCKET
 *   S3_ACCESS_KEY                                                                    MINIO_ROOT_USER
 *   S3_SECRET_KEY                                                                    MINIO_ROOT_PASSWORD
 *   S3_SESSION_TOKEN optional, for temporary credentials
 *   S3_PATH_STYLE    default true. `host/bucket/key` addressing, which MinIO, Garage and most
 *                    self-hosted stores need; set false for virtual-hosted `bucket.host/key`
 *                    (what AWS S3 prefers).
 *
 * Pure (reads only what it is given), so every case can be tested without a store.
 */
export interface S3Config {
  endPoint: string;
  /** Undefined means the protocol's default (80 or 443). */
  port: number | undefined;
  useSSL: boolean;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  sessionToken: string | undefined;
  pathStyle: boolean;
}

type Env = Record<string, string | undefined>;

/** The first of `names` that is set and non-empty. */
function pick(env: Env, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

function flag(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

export function resolveS3Config(env: Env = process.env): S3Config {
  const rawEndpoint = pick(env, "S3_ENDPOINT", "MINIO_ENDPOINT") ?? "minio:9000";
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawEndpoint);
  let url: URL;
  try {
    url = new URL(hasScheme ? rawEndpoint : `http://${rawEndpoint}`);
  } catch {
    throw new Error(`S3_ENDPOINT "${rawEndpoint}" is not host[:port] or a URL`);
  }
  if (hasScheme && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`S3_ENDPOINT must start with http:// or https:// (got ${url.protocol}//)`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("S3_ENDPOINT must be a host (and port) without a path");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("S3_ENDPOINT has no host");
  const port = url.port ? Number(url.port) : undefined;

  const flagName = env.S3_USE_SSL !== undefined && env.S3_USE_SSL !== "" ? "S3_USE_SSL" : "MINIO_USE_SSL";
  const explicit = flag(flagName, pick(env, "S3_USE_SSL", "MINIO_USE_SSL"));
  const fromScheme = hasScheme ? url.protocol === "https:" : undefined;
  if (explicit !== undefined && fromScheme !== undefined && explicit !== fromScheme) {
    throw new Error(`${flagName}=${explicit} contradicts the ${url.protocol}// in S3_ENDPOINT`);
  }
  const useSSL = explicit ?? fromScheme ?? false;

  const accessKey = pick(env, "S3_ACCESS_KEY", "MINIO_ROOT_USER");
  const secretKey = pick(env, "S3_SECRET_KEY", "MINIO_ROOT_PASSWORD");
  if (!accessKey || !secretKey) {
    throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY must be set (or MINIO_ROOT_USER and MINIO_ROOT_PASSWORD)");
  }

  return {
    endPoint: host,
    port,
    useSSL,
    region: pick(env, "S3_REGION", "MINIO_REGION") ?? "us-east-1",
    bucket: pick(env, "S3_BUCKET", "MINIO_BUCKET") ?? "church-files",
    accessKey,
    secretKey,
    sessionToken: pick(env, "S3_SESSION_TOKEN"),
    pathStyle: flag("S3_PATH_STYLE", pick(env, "S3_PATH_STYLE")) ?? true,
  };
}

/** What to show about the store (never the keys). */
export function describeS3(cfg: S3Config): Record<string, string> {
  const hostPort = cfg.port ? `${cfg.endPoint}:${cfg.port}` : cfg.endPoint;
  return {
    endpoint: `${cfg.useSSL ? "https" : "http"}://${hostPort}`,
    bucket: cfg.bucket,
    region: cfg.region,
    addressing: cfg.pathStyle ? "path-style" : "virtual-hosted",
  };
}
