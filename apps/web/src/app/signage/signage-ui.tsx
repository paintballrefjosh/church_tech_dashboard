"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CalendarRange, Clapperboard, Cpu, ListVideo, Power, BookOpen, Settings, Tv, type LucideIcon } from "lucide-react";
import { PERMISSIONS, type SignageDeviceProblem, type SignagePlaylist, type SignageScreen, type SignageScreenGroup } from "@lampstand/shared";
import { can, useViewer, type Viewer } from "@/components/assets-ui";

/** Every page of the module, its settings included (docs/signage.md section 6: you stay within the module). */
const TABS: Array<{ href: string; label: string; Icon: LucideIcon; need: string; match: (p: string) => boolean }> = [
  { href: "/signage", label: "Screens", Icon: Tv, need: PERMISSIONS.SIGNAGE_READ_ANY, match: (p) => p === "/signage" || p.startsWith("/signage/screens") },
  { href: "/signage/schedules", label: "Schedule", Icon: CalendarRange, need: PERMISSIONS.SIGNAGE_READ_ANY, match: (p) => p.startsWith("/signage/schedules") },
  { href: "/signage/playlists", label: "Playlists", Icon: ListVideo, need: PERMISSIONS.SIGNAGE_READ_ANY, match: (p) => p.startsWith("/signage/playlists") },
  { href: "/signage/media", label: "Media", Icon: Clapperboard, need: PERMISSIONS.SIGNAGE_READ_ANY, match: (p) => p.startsWith("/signage/media") },
  { href: "/signage/power", label: "Power", Icon: Power, need: PERMISSIONS.SIGNAGE_READ_ANY, match: (p) => p.startsWith("/signage/power") },
  { href: "/signage/devices", label: "Devices", Icon: Cpu, need: PERMISSIONS.SIGNAGE_ADMIN, match: (p) => p.startsWith("/signage/devices") },
  { href: "/signage/settings", label: "Settings", Icon: Settings, need: PERMISSIONS.SIGNAGE_ADMIN, match: (p) => p.startsWith("/signage/settings") || p.startsWith("/signage/security") },
  { href: "/signage/guide", label: "Guide", Icon: BookOpen, need: PERMISSIONS.SIGNAGE_READ_ANY, match: (p) => p.startsWith("/signage/guide") },
];

/** The module's tab row. The Devices tab carries how many Pis need attention (and new ones found). */
export function SignageTabs() {
  const pathname = usePathname();
  const me = useViewer();
  const [attention, setAttention] = useState(0);
  const admin = can(me, PERMISSIONS.SIGNAGE_ADMIN);
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    const load = () =>
      fetch("/api/signage/summary", { credentials: "same-origin", cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ attention: number; newFound: number }>) : null))
        .then((s) => {
          if (!cancelled && s) setAttention(s.attention + s.newFound);
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [admin]);
  return (
    <nav aria-label="Signage" className="mb-6 flex flex-wrap items-center gap-1 border-b border-slate-300 text-sm dark:border-slate-800">
      {TABS.filter((t) => !me || can(me, t.need)).map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`mb-[-1px] inline-flex items-center gap-1.5 border-b-2 px-3 py-2 ${
              active ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            <t.Icon className="h-4 w-4" aria-hidden />
            {t.label}
            {t.href === "/signage/devices" && attention > 0 ? (
              <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/60 dark:text-amber-200" aria-label={`${attention} need attention`}>
                {attention}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export interface SignagePerms {
  me: Viewer | null;
  write: boolean;
  admin: boolean;
}

export function useSignagePerms(): SignagePerms {
  const me = useViewer();
  return { me, write: can(me, PERMISSIONS.SIGNAGE_WRITE_ANY), admin: can(me, PERMISSIONS.SIGNAGE_ADMIN) };
}

/** GET a JSON list or object from the module's proxy; `forbidden` once the API says 403. */
export function useSignageJson<T>(path: string | null): { data: T | null; error: string | null; forbidden: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    const r = await fetch(`/api/signage/${path}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!r) return setError("The dashboard could not be reached.");
    if (r.status === 403) return setForbidden(true);
    if (!r.ok) return setError(`Could not load (${r.status}).`);
    setError(null);
    setData((await r.json()) as T);
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, forbidden, reload };
}

export function Forbidden() {
  return <p className="text-sm text-slate-600 dark:text-slate-300">Your groups do not include Signage. A Signage admin or site admin can add you.</p>;
}

/** Monday first, as `daysOfWeek` numbers them (1 = Monday ... 7 = Sunday). */
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function daysText(days: number[]): string {
  const d = [...days].sort((a, b) => a - b);
  if (d.length === 7) return "Every day";
  if (d.join() === "1,2,3,4,5") return "Weekdays";
  if (d.join() === "6,7") return "Weekends";
  return d.map((n) => DAY_NAMES[n - 1]).join(", ");
}

export function DayPicker({ value, onChange, idPrefix }: { value: number[]; onChange: (v: number[]) => void; idPrefix: string }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Days</legend>
      <div className="mt-1 flex flex-wrap gap-1">
        {DAY_NAMES.map((n, i) => {
          const day = i + 1;
          const on = value.includes(day);
          return (
            <label
              key={n}
              htmlFor={`${idPrefix}-d${day}`}
              className={`inline-flex min-h-[32px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border px-2 text-sm ${
                on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200"
              }`}
            >
              <input
                id={`${idPrefix}-d${day}`}
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => onChange(on ? value.filter((x) => x !== day) : [...value, day].sort((a, b) => a - b))}
              />
              {n}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** What a schedule entry or power rule is for, as words. */
export function targetText(t: { targetType: string; targetName: string }): string {
  if (t.targetType === "all") return "All screens";
  return t.targetType === "group" ? `Group: ${t.targetName}` : t.targetName;
}

/** Pick "all screens" (when `allowAll`), a screen group or one screen. */
export function TargetPicker({
  id,
  targetType,
  targetId,
  onChange,
  screens,
  groups,
  allowAll,
}: {
  id: string;
  targetType: string;
  targetId: string | null;
  onChange: (type: "screen" | "group" | "all", id: string | null) => void;
  screens: SignageScreen[];
  groups: SignageScreenGroup[];
  allowAll: boolean;
}) {
  const value = targetType === "all" ? "all" : targetId ? `${targetType}:${targetId}` : "";
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "all") return onChange("all", null);
        const [type, tid] = v.split(":");
        onChange(type as "screen" | "group", tid ?? null);
      }}
      className={inputCls}
    >
      <option value="" disabled>
        Pick a screen or group
      </option>
      {allowAll ? <option value="all">All screens</option> : null}
      {groups.length ? (
        <optgroup label="Screen groups">
          {groups.map((g) => (
            <option key={g.id} value={`group:${g.id}`}>
              {g.name} ({g.screenCount} screen{g.screenCount === 1 ? "" : "s"})
            </option>
          ))}
        </optgroup>
      ) : null}
      <optgroup label="Screens">
        {screens.map((s) => (
          <option key={s.id} value={`screen:${s.id}`}>
            {s.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export function PlaylistSelect({ id, value, onChange, playlists, allowNone }: { id: string; value: string | null; onChange: (v: string | null) => void; playlists: SignagePlaylist[]; allowNone?: string }) {
  return (
    <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={inputCls}>
      {allowNone ? <option value="">{allowNone}</option> : <option value="" disabled>Pick a playlist</option>}
      {playlists.filter((p) => !p.isAdhoc || p.id === value).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.items.length} item{p.items.length === 1 ? "" : "s"})
        </option>
      ))}
    </select>
  );
}

export const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
export const btnCls = "inline-flex min-h-[32px] items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800";
export const primaryCls = "inline-flex min-h-[32px] items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60";
export const dangerCls = "inline-flex min-h-[32px] items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950";

export function Label({ htmlFor, children, hint }: { htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700 dark:text-slate-200">
      {children}
      {hint ? <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{hint}</span> : null}
    </label>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
      {text}
    </p>
  );
}

/**
 * A screen drawn as a TV: a dark bezel around a 16:9 (or 9:16) picture, the item playing now if one is known, and a small
 * stand. Used for every screen tile so the page reads as the wall of TVs it manages.
 */
export function TvFrame({ screen, thumb, label }: { screen: Pick<SignageScreen, "orientation" | "powerNow" | "enabled">; thumb: string | null; label: string }) {
  const portrait = screen.orientation === "portrait";
  const off = screen.powerNow === "off" || !screen.enabled;
  return (
    <div className="flex flex-col items-center">
      <div className={`relative overflow-hidden rounded-md border-[6px] border-slate-900 bg-slate-950 shadow-md dark:border-black ${portrait ? "aspect-[9/16] w-1/2" : "aspect-video w-full"}`}>
        {thumb && !off ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={label} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs uppercase tracking-widest text-slate-400">{off ? "Off" : "No picture"}</div>
        )}
        <span className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ${off ? "bg-rose-500" : "bg-emerald-400"}`} aria-hidden />
      </div>
      <div className="h-2 w-10 rounded-b-sm bg-slate-400 dark:bg-slate-700" aria-hidden />
    </div>
  );
}

/** Problem codes that mean "an update is waiting": the OS updates and an agent behind the dashboard's. */
const UPDATE_CODES = new Set(["os_updates", "agent"]);

export function ProblemBadges({ problems }: { problems: SignageDeviceProblem[] }) {
  if (!problems.length) return null;
  return (
    <ul className="flex flex-wrap gap-1">
      {problems.map((p) => (
        <li
          key={p.code}
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            p.severity === "critical"
              ? "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200"
              : p.severity === "warning"
                ? "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
                : UPDATE_CODES.has(p.code)
                  ? // Updates are not faults (they stay off "Needs attention") but are something to do: blue, not the grey of plain notes.
                    "bg-sky-100 text-sky-900 ring-1 ring-inset ring-sky-300 dark:bg-sky-900/60 dark:text-sky-100 dark:ring-sky-700"
                  : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
          }`}
        >
          {p.message}
        </li>
      ))}
    </ul>
  );
}

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

export function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function bytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function seconds(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** A local "YYYY-MM-DDTHH:MM" for a datetime-local input, from an instant (this browser's clock). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
