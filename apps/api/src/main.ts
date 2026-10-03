import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import { MAX_ATTACHMENT_BYTES } from "@church/shared";
import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./realtime/redis-io-adapter";

/**
 * Build the CORS origin checker. Same-origin (Caddy proxy) requests have no
 * Origin header and pass freely. Cross-origin requests are allowed if they
 * match the comma-separated APP_URL allowlist; otherwise rejected.
 *
 * Reflecting Origin with credentials (the previous default) lets any site on
 * the internet read the API as a logged-in user via fetch(). We don't do that.
 */
function buildCorsOrigin(): (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void {
  const raw = process.env.APP_URL?.trim();
  const allowlist = raw
    ? raw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)
    : [];
  return (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    const normalised = origin.replace(/\/$/, "");
    if (allowlist.includes(normalised)) return cb(null, true);
    cb(null, false);
  };
}

async function bootstrap() {
  const adapter = new FastifyAdapter({ logger: false, trustProxy: true });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  await app.register(fastifyCookie as never);
  await app.register(fastifyMultipart as never, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: 1, // controllers consume one file at a time
    },
  });

  // Global rate limit. Default of 300 req/min/IP is generous for normal
  // browsing (one user clicking around shouldn't trip it) but caps any
  // single host hitting us in a loop. The /auth/* burst limit below is the
  // one that actually deters credential / TOTP brute-force.
  await app.register(fastifyRateLimit as never, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Allow per-route overrides via @nestjs route config.
    skipOnError: true,
  });
  // Stricter bucket for the auth endpoints — sign-in, TOTP verify, password
  // change. 10/minute/IP is enough for a clumsy user, way too few for online
  // password / 6-digit brute force.
  app.getHttpAdapter().getInstance().addHook("onRoute", (route: { path?: string; config?: Record<string, unknown> }) => {
    const path = route.path ?? "";
    if (!route.config) route.config = {};
    if (
      path.includes("/auth/verify-credentials") ||
      path.includes("/auth/totp/") ||
      path.includes("/me/change-password")
    ) {
      (route.config as { rateLimit?: { max: number; timeWindow: string } }).rateLimit = {
        max: 10,
        timeWindow: "1 minute",
      };
    }
  });

  // Socket.IO Redis adapter so emit-to-user works across API replicas.
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  app.setGlobalPrefix("api/v1");
  // CORS: same-origin requests through the Caddy proxy (no Origin header)
  // pass freely. Cross-origin requests must match APP_URL (comma-separated
  // allowlist of full origins). We never reflect arbitrary origins with
  // credentials — that would turn a logged-in browser into a CSRF vector
  // for any site on the internet. To deliberately disable CORS, leave
  // APP_URL unset; only Caddy-proxied (same-origin) requests will succeed,
  // which is the right default for self-hosted single-tenant.
  app.enableCors({
    origin: buildCorsOrigin(),
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
  Logger.log(`API listening on :${port} (prefix /api/v1)`, "Bootstrap");
}

bootstrap().catch((err) => {
  // Fall back to console — Logger may not be initialised on bootstrap failure
  // eslint-disable-next-line no-console
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
