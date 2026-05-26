import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import { MAX_ATTACHMENT_BYTES } from "@church/shared";
import { AppModule } from "./app.module";

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

  app.setGlobalPrefix("api/v1");
  // Validation: Zod schemas inside each controller, not class-validator.
  // CORS: echo whatever Origin the request used (browser will reject if the
  // server doesn't match), with credentials. This means the app works at every
  // hostname you point at it without code changes. If you want to lock CORS
  // down to a known origin, set APP_URL in .env.
  app.enableCors({
    origin: process.env.APP_URL ?? true,
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
