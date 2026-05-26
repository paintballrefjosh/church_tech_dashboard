import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger, Inject } from "@nestjs/common";
import type { Server, Socket } from "socket.io";
import { decode } from "@auth/core/jwt";
import { AuthService } from "../auth/auth.service";

const SESSION_COOKIE_CANDIDATES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = decodeURIComponent(part.slice(eq + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

@WebSocketGateway({
  cors: { origin: process.env.APP_URL ?? true, credentials: true },
  transports: ["websocket", "polling"],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async handleConnection(socket: Socket): Promise<void> {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const secret = process.env.AUTH_SECRET;
    let userId: string | null = null;
    if (secret) {
      for (const name of SESSION_COOKIE_CANDIDATES) {
        const token = cookies[name];
        if (!token) continue;
        try {
          const decoded = await decode({ token, secret, salt: name });
          if (typeof decoded?.sub === "string") {
            const user = await this.auth.loadUserById(decoded.sub);
            if (user) {
              userId = user.id;
              break;
            }
          }
        } catch {
          // try next
        }
      }
    }
    if (!userId) {
      this.logger.debug(`ws connect rejected: no session (${socket.id})`);
      socket.disconnect(true);
      return;
    }
    socket.data.userId = userId;
    await socket.join(`user:${userId}`);
    this.logger.debug(`ws connect ok user=${userId} sid=${socket.id}`);
  }

  handleDisconnect(socket: Socket): void {
    this.logger.debug(`ws disconnect sid=${socket.id}`);
  }

  /**
   * Emit an event to every socket joined to `user:{id}` (i.e. every browser
   * tab that user has open). Safe to call before the server is up — falls
   * silently to a no-op when `this.server` is undefined.
   */
  toUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  /** Broadcast to a named room, e.g. `wiki:{id}` for a wiki page. */
  toRoom(room: string, event: string, payload: unknown): void {
    this.server?.to(room).emit(event, payload);
  }
}
