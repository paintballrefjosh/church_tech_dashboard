"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { ASSET_STATUS_LABELS, groupLocations, locationLabel, type Asset, type AssetStatus, type Location } from "@church/shared";

/** Who is looking: id, name and permission strings from `GET /me` (null until read). */
export interface Viewer {
  id: string;
  name: string;
  permissions: string[];
}

export function useViewer(): Viewer | null {
  const [me, setMe] = useState<Viewer | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: { id: string; name: string | null; email: string; permissions?: string[] } | null) => {
        if (!cancelled && u) setMe({ id: u.id, name: u.name ?? u.email, permissions: u.permissions ?? [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return me;
}

export const can = (me: Viewer | null, p: string) => !!me?.permissions.includes(p);

/** The API's error body as one line (a Zod flatten or a plain message). */
export function errorText(body: unknown, status: number): string {
  const m = (body as { message?: unknown } | null)?.message as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | string | undefined;
  if (typeof m === "string") return m;
  const field = Object.entries(m?.fieldErrors ?? {})[0];
  if (field) return `${field[0]}: ${field[1][0]}`;
  return m?.formErrors?.[0] ?? `Failed (${status})`;
}

export async function sendJson<T = unknown>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => null)) as unknown;
  if (!r.ok) throw new Error(errorText(json, r.status));
  return json as T;
}

/** Every room, read once per page (null while loading, [] when it could not be read). */
export function useRooms(enabled = true): [Location[] | null, () => Promise<void>] {
  const [rooms, setRooms] = useState<Location[] | null>(null);
  const load = async () => {
    const r = await fetch("/api/locations", { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    setRooms(r?.ok ? ((await r.json()) as Location[]) : []);
  };
  useEffect(() => {
    if (enabled) void load();
  }, [enabled]);
  return [rooms, load];
}

const fieldCls = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";

/** The bare room select (no label of its own): rooms grouped by building, "No room" first. Name it with `aria-label` or a label's `htmlFor`. */
export function RoomSelect({
  value,
  onChange,
  rooms,
  id,
  className = `${fieldCls} mt-1`,
  ariaLabel,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  rooms: Location[] | null;
  id?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const missing = value && rooms && !rooms.some((r) => r.id === value);
  return (
    <select id={id} aria-label={ariaLabel} className={className} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled || rooms === null}>
      <option value="">{rooms === null ? "Loading rooms…" : "No room"}</option>
      {missing ? <option value={value}>(a room that was removed)</option> : null}
      {groupLocations(rooms ?? []).map((g) =>
        g.building ? (
          <optgroup key={g.building} label={g.building}>
            {g.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </optgroup>
        ) : (
          g.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))
        ),
      )}
    </select>
  );
}

/**
 * The room picker every form shares, with its own label so it can be dropped into any form; `hint` explains the field where
 * it is not obvious. Reads the rooms itself unless given them.
 */
export function RoomField({
  value,
  onChange,
  label = "Room",
  hint,
  rooms: given,
  id: givenId,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  hint?: string;
  rooms?: Location[] | null;
  id?: string;
}) {
  const own = useRooms(given === undefined)[0];
  const rooms = given ?? own;
  const autoId = useId();
  const id = givenId ?? autoId;
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-slate-500 dark:text-slate-400">
        {label}
      </label>
      <RoomSelect id={id} value={value} onChange={onChange} rooms={rooms} />
      {hint ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
      {rooms && rooms.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          No rooms yet. An admin adds them on the{" "}
          <Link href="/rooms" className="text-brand-600 underline dark:text-brand-400">
            Rooms
          </Link>{" "}
          page.
        </p>
      ) : null}
    </div>
  );
}

/** A room as a link to its page ("Booth (Main building)"), or nothing. */
export function RoomLink({ room, rooms }: { room: { id: string; name: string } | null; rooms?: Location[] | null }) {
  if (!room) return null;
  const full = rooms?.find((r) => r.id === room.id);
  return (
    <Link href={`/rooms/${room.id}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
      <MapPin className="h-3.5 w-3.5" aria-hidden />
      {full ? locationLabel(full) : room.name}
    </Link>
  );
}

const STATUS_CLS: Record<AssetStatus, string> = {
  in_service: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  in_repair: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  retired: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  lost: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export function StatusChip({ status }: { status: AssetStatus }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLS[status]}`}>{ASSET_STATUS_LABELS[status]}</span>;
}

/** Where the item is now, in words: with someone (and whether it is late), installed, or on the shelf. */
export function HolderLine({ asset }: { asset: Pick<Asset, "holder" | "lendable"> }) {
  const h = asset.holder;
  if (!h) return <span className="text-slate-500 dark:text-slate-400">{asset.lendable ? "Available" : "Installed"}</span>;
  return (
    <span>
      With <span className="font-medium">{h.name}</span>
      {h.dueOn ? (
        <span className={h.overdue ? " font-medium text-rose-700 dark:text-rose-300" : " text-slate-500 dark:text-slate-400"}>
          {h.overdue ? ` · was due ${h.dueOn}` : ` · due ${h.dueOn}`}
        </span>
      ) : null}
    </span>
  );
}

/** Today on this browser's calendar, as YYYY-MM-DD (for date inputs' minimum). */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
