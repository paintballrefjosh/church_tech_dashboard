import { IoAdapter } from "@nestjs/platform-socket.io";
import { Logger, type INestApplicationContext } from "@nestjs/common";
import { createAdapter } from "@socket.io/redis-adapter";
import type { ServerOptions } from "socket.io";
import Redis from "ioredis";

/**
 * Socket.IO adapter that swaps the default in-memory rooms registry for a
 * Redis-pub-sub-backed one. Without this, emitting to `user:{id}` on one API
 * replica silently drops the event if the recipient's WS happens to be
 * connected to a different replica.
 *
 * Best-effort: if Redis is unreachable at boot we log a warning and fall back
 * to the default in-memory adapter. The single-replica dev stack keeps
 * working; multi-replica deploys will then visibly lose events (which is the
 * signal to investigate Redis, not the signal to silently soldier on).
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connect(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn("REDIS_URL not set; Socket.IO will use in-memory adapter (single-replica only).");
      return;
    }
    try {
      const pubClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(`Socket.IO Redis adapter connected (${url})`);
    } catch (err) {
      this.logger.warn(
        `Socket.IO Redis adapter unavailable (${(err as Error).message}); falling back to in-memory.`,
      );
    }
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
