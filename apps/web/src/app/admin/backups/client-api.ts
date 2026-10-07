"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupOperation } from "@church/shared";

/**
 * Browser-side helpers for the backups pages. The browser talks to the API directly
 * (/api/v1/admin/backups/...), with the session cookie, like the reindex button does.
 */
const BASE = "/api/v1/admin/backups";

/** The API's error text, whether it sent a message, a list of messages or a validation report. */
export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
    if (Array.isArray(body.message)) return body.message.join(" ");
    if (body.message && typeof body.message === "object") {
      const flat = body.message as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
      const parts = [...(flat.formErrors ?? []), ...Object.entries(flat.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v.join(", ")}`)];
      if (parts.length) return parts.join("; ");
    }
  } catch {
    // not JSON
  }
  if (res.status === 503) return "Changes are paused while a backup is being restored. Try again in a few minutes.";
  return `${fallback} (${res.status})`;
}

export async function api<T>(path: string, init: RequestInit = {}, fallback = "Request failed"): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined && !(init.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

export function post<T>(path: string, body?: unknown, fallback?: string): Promise<T> {
  return api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }, fallback);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-GB");
}

export const KIND_LABEL: Record<string, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  pre_restore: "Safety copy",
  uploaded: "Uploaded",
};

/**
 * Follow a long-running operation: poll it once a second until it finishes. `track(id)` starts
 * following one (also one that was already running when the page loaded); `onDone` runs once with
 * the final state.
 */
export function useOperation<R = unknown>(onDone?: (op: BackupOperation<R>) => void) {
  const [op, setOp] = useState<BackupOperation<R> | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
  }, []);

  const track = useCallback(
    (id: string) => {
      stop();
      current.current = id;
      setLost(null);
      let failures = 0;
      const tick = async () => {
        if (current.current !== id) return;
        try {
          const res = await fetch(`${BASE}/operations/${id}`, { credentials: "same-origin", cache: "no-store" });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const next = (await res.json()) as BackupOperation<R>;
          failures = 0;
          if (current.current !== id) return;
          setOp(next);
          if (next.status !== "running") {
            current.current = null;
            done.current?.(next);
            return;
          }
        } catch (err) {
          // The page can briefly lose the server while a restore pauses things, or while a node restarts.
          failures++;
          if (failures >= 60) {
            setLost(`Lost contact with the server (${(err as Error).message}).`);
            current.current = null;
            return;
          }
        }
        timer.current = setTimeout(() => void tick(), 1000);
      };
      void tick();
    },
    [stop],
  );

  const clear = useCallback(() => {
    stop();
    setOp(null);
    setLost(null);
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { op, lost, track, clear };
}
