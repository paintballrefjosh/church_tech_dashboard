"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type Handlers = Record<string, (payload: unknown) => void>;

/**
 * Subscribe to one or more server rooms over the shared Socket.io connection
 * and dispatch incoming events to `handlers`. `onReady` fires on every
 * (re)connect — use it to pull a fresh full snapshot so a client that was
 * disconnected can't drift (deltas missed while offline are reconciled).
 *
 * The hook never throws: if the socket can't be established the caller's
 * polling fallback carries the page. `connected` lets a caller show a live
 * indicator and/or keep polling only while the socket is down.
 */
export function useRealtimeRoom(
  rooms: string | string[],
  handlers: Handlers,
  onReady?: () => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const roomList = Array.isArray(rooms) ? rooms : [rooms];
  const roomsKey = roomList.join(",");

  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io({
        path: "/socket.io",
        // WebSocket only: long-polling would need a sticky load balancer across nodes.
        transports: ["websocket"],
        withCredentials: true,
        reconnection: true,
      });
    } catch {
      return; // no socket — caller keeps polling
    }
    const s = socket;
    const events = Object.keys(handlersRef.current);
    const listeners: Record<string, (p: unknown) => void> = {};
    for (const ev of events) {
      const l = (p: unknown) => handlersRef.current[ev]?.(p);
      listeners[ev] = l;
      s.on(ev, l);
    }
    s.on("connect", () => {
      setConnected(true);
      s.emit("subscribe", roomList);
      onReadyRef.current?.();
    });
    s.on("disconnect", () => setConnected(false));

    return () => {
      for (const ev of events) s.off(ev, listeners[ev]);
      try {
        s.emit("unsubscribe", roomList);
      } catch {
        /* socket may already be closed */
      }
      s.disconnect();
    };
    // Re-establish only when the room set changes (e.g. detail page id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey]);

  return { connected };
}
