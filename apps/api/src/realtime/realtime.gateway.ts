import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  type OnGatewayInit,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger, Inject } from "@nestjs/common";
import type { Server, Socket } from "socket.io";
import { decode } from "@auth/core/jwt";
import { AuthService } from "../auth/auth.service";

/**
 * Rooms a client may `subscribe` to, and the permission each one requires.
 * Keys ending in `:` are prefixes — the client appends a resource id (e.g.
 * `monitor:abc`). Anything not listed here is refused, so a browser can only
 * join rooms it's authorised to read.
 */
const ROOM_PERMISSIONS: ReadonlyArray<{ exact?: string; prefix?: string; permission: string }> = [
  { exact: "monitoring", permission: "monitors:read:any" },
  { prefix: "monitor:", permission: "monitors:read:any" },
  { exact: "infra", permission: "monitors:read:any" },
  { prefix: "infra:", permission: "monitors:read:any" },
  { exact: "network", permission: "unifi:read:any" },
];

function requiredPermission(room: string): string | null {
  for (const r of ROOM_PERMISSIONS) {
    if (r.exact && room === r.exact) return r.permission;
    if (r.prefix && room.startsWith(r.prefix) && room.length > r.prefix.length) return r.permission;
  }
  return null;
}

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

/**
 * CORS allowlist mirrored from the HTTP side. The WS handshake includes an
 * Origin header from any browser, so without this any site on the internet
 * could open a WS as a signed-in user.
 */
function wsAllowedOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) return cb(null, true);
  const raw = process.env.APP_URL?.trim();
  const allowlist = raw
    ? raw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)
    : [];
  const normalised = origin.replace(/\/$/, "");
  cb(null, allowlist.includes(normalised));
}

@WebSocketGateway({
  cors: { origin: wsAllowedOrigin, credentials: true },
  transports: ["websocket", "polling"],
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * Authenticate during the handshake, NOT in handleConnection. The
   * middleware is awaited before the socket is considered connected, so a
   * client that fires `subscribe` the instant it connects is guaranteed to
   * have its permissions resolved first. Doing this in handleConnection (an
   * async DB call) instead races the first inbound message.
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticate(socket)
        .then((auth) => {
          if (!auth) {
            next(new Error("unauthorized"));
            return;
          }
          socket.data.userId = auth.userId;
          socket.data.permissions = auth.permissions;
          next();
        })
        .catch(() => next(new Error("unauthorized")));
    });
  }

  private async authenticate(
    socket: Socket,
  ): Promise<{ userId: string; permissions: string[] } | null> {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const secret = process.env.AUTH_SECRET;
    if (!secret) return null;
    for (const name of SESSION_COOKIE_CANDIDATES) {
      const token = cookies[name];
      if (!token) continue;
      try {
        const decoded = await decode({ token, secret, salt: name });
        if (typeof decoded?.sub === "string") {
          const user = await this.auth.loadUserById(decoded.sub);
          if (user) return { userId: user.id, permissions: user.permissions };
        }
      } catch {
        // try next candidate cookie name
      }
    }
    return null;
  }

  async handleConnection(socket: Socket): Promise<void> {
    const userId = socket.data.userId as string | undefined;
    if (!userId) {
      // Should be unreachable — middleware rejects unauthenticated sockets —
      // but guard defensively so a socket can never linger unauthenticated.
      socket.disconnect(true);
      return;
    }
    await socket.join(`user:${userId}`);
    this.logger.debug(`ws connect ok user=${userId} sid=${socket.id}`);
  }

  handleDisconnect(socket: Socket): void {
    this.logger.debug(`ws disconnect sid=${socket.id}`);
  }

  /**
   * A client asks to join one or more resource rooms (e.g. `monitoring`,
   * `monitor:{id}`, `infra`, `network`). Each request is checked against the
   * permissions resolved at connect time; unauthorised or unknown rooms are
   * silently skipped. Returns the rooms actually joined so the client can tell
   * whether to fall back to polling.
   */
  @SubscribeMessage("subscribe")
  async onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ joined: string[] }> {
    const perms = new Set<string>((socket.data.permissions as string[] | undefined) ?? []);
    const rooms = normaliseRooms(body);
    const joined: string[] = [];
    for (const room of rooms) {
      const need = requiredPermission(room);
      if (!need || !perms.has(need)) continue;
      await socket.join(room);
      joined.push(room);
    }
    return { joined };
  }

  @SubscribeMessage("unsubscribe")
  async onUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ left: string[] }> {
    const rooms = normaliseRooms(body);
    for (const room of rooms) await socket.leave(room);
    return { left: rooms };
  }

  /**
   * Number of sockets joined to `room` on THIS node. Used by pollers to skip
   * work when nobody's watching. Local-only by design: with the Redis adapter
   * each replica polls independently for its own viewers, which bounds load to
   * one poll per replica-with-viewers rather than fanning a cluster-wide count.
   */
  roomSize(room: string): number {
    return this.server?.sockets?.adapter?.rooms?.get(room)?.size ?? 0;
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

/** Accept a single room string or an array of them; drop non-strings. */
function normaliseRooms(body: unknown): string[] {
  const raw = Array.isArray(body) ? body : [body];
  return raw.filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 128);
}
