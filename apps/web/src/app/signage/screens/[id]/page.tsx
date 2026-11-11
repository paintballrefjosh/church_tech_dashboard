"use client";

import { use, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Power, Trash2, Tv } from "lucide-react";
import type { SignagePlaylist, SignagePreview, SignageScreen, SignageScreenGroup } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { GoneNotice } from "@/components/gone-notice";
import { sendJson } from "@/components/assets-ui";
import { ScreenFormModal } from "../../screen-form";
import { ScreenCalendar } from "../../schedules/schedule-calendar";
import { ErrorLine, Forbidden, Label, TvFrame, btnCls, dangerCls, inputCls, seconds, useSignageJson, useSignagePerms, when } from "../../signage-ui";

export default function SignageScreenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const perms = useSignagePerms();
  const router = useRouter();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [screen, setScreen] = useState<SignageScreen | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "gone" | "forbidden">("loading");
  const [editing, setEditing] = useState(false);
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const playlists = useSignageJson<SignagePlaylist[]>("playlists");

  const load = async () => {
    const r = await fetch(`/api/signage/screens/${id}`, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 404) return setStatus("gone");
    if (r.status === 403) return setStatus("forbidden");
    if (r.ok) {
      setScreen((await r.json()) as SignageScreen);
      setStatus("ok");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function remove() {
    if (!screen) return;
    const pi = screen.device ? ` The Pi ${screen.device.name} stays set up but drives no screen; it keeps playing what it already has until you give it another one.` : "";
    if (!window.confirm(`Delete the screen ${screen.name}? Its schedule entries and power times are deleted with it. Playlists and media are kept.${pi}`)) return;
    setDeleteError(null);
    try {
      await sendJson(`/api/signage/screens/${id}`, "DELETE");
      router.push("/signage");
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  }

  if (status === "forbidden") return <Forbidden />;
  if (status === "gone") return <GoneNotice what="screen" backHref="/signage" backLabel="Screens" />;
  if (!screen) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/signage" className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Screens
        </Link>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={Tv}>{screen.name}</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {screen.orientation === "portrait" ? "Portrait" : "Landscape"} ·{" "}
            {screen.tvControl === "roku_ecp" ? "Roku TV" : screen.tvControl === "cec" ? "HDMI-CEC TV" : "TV not controlled"}
            {screen.locationName ? ` · ${screen.locationName}` : ""}
            {screen.groupIds.length && groups.data ? ` · ${groups.data.filter((g) => screen.groupIds.includes(g.id)).map((g) => g.name).join(", ")}` : ""}
          </p>
        </div>
        {perms.admin ? (
          <div className="flex gap-2">
            <button type="button" className={btnCls} onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </button>
            <button type="button" className={dangerCls} onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          </div>
        ) : null}
      </div>
      <ErrorLine text={deleteError} />

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <NowAndWhy screen={screen} />
        <div className="space-y-4">
          <DeviceCard screen={screen} admin={perms.admin} />
          {perms.admin && screen.tvControl !== "none" ? <TvControls screen={screen} /> : null}
        </div>
      </div>

      <ScreenCalendar screen={screen} />

      {editing ? (
        <ScreenFormModal
          initial={screen}
          groups={groups.data ?? []}
          playlists={playlists.data ?? []}
          onClose={() => setEditing(false)}
          onSaved={(s) => {
            setEditing(false);
            setScreen(s);
          }}
        />
      ) : null}
    </div>
  );
}

/** What the screen shows at a chosen moment (now by default), and which rule won and why. */
function NowAndWhy({ screen }: { screen: SignageScreen }) {
  const id = useId();
  const [at, setAt] = useState<string>("");
  const [p, setP] = useState<SignagePreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    const q = at ? `?at=${encodeURIComponent(new Date(at).toISOString())}` : "";
    fetch(`/api/signage/screens/${screen.id}/preview${q}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SignagePreview>) : null))
      .then((x) => !cancelled && setP(x))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [screen.id, at, screen.updatedAt]);
  const first = p?.items[0];
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-800">
      <h2 id={`${id}-h`} className="text-base font-semibold text-slate-900 dark:text-slate-100">
        {at ? "Shown at the chosen time" : "Showing now"}
      </h2>
      <TvFrame screen={{ ...screen, powerNow: p?.power ?? screen.powerNow }} thumb={first ? `/api/signage/media/${first.mediaId}/thumb` : null} label={first ? first.name : "Nothing showing"} />
      <div>
        <Label htmlFor={`${id}-at`} hint="Pick any time to see what this screen would show then (in this computer's time).">
          Look at another time
        </Label>
        <div className="flex gap-2">
          <input id={`${id}-at`} type="datetime-local" className={inputCls} value={at} onChange={(e) => setAt(e.target.value)} />
          {at ? (
            <button type="button" className={btnCls} onClick={() => setAt("")}>
              Now
            </button>
          ) : null}
        </div>
      </div>
      {p ? (
        <>
          <p className="text-sm text-slate-700 dark:text-slate-200">{p.why}</p>
          {p.power === "off" ? <p className="text-sm font-medium text-slate-700 dark:text-slate-200">The TV is off by its power schedule then.</p> : null}
          {p.items.length ? (
            <ol className="space-y-1 text-sm">
              {p.items.map((it, i) => (
                <li key={`${it.mediaId}-${i}`} className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/signage/media/${it.mediaId}/thumb`} alt="" className="h-8 w-14 rounded object-cover" loading="lazy" />
                  <span className="flex-1 truncate text-slate-800 dark:text-slate-100">{it.name}</span>
                  <span className="text-slate-500 dark:text-slate-400">{seconds(it.seconds)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {p.candidates.length > 1 || (!p.playlistId && p.candidates.length > 0) ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-brand-600 dark:text-brand-400">Everything that could show then ({p.candidates.length})</summary>
              <ul className="mt-2 space-y-1">
                {p.candidates.map((c, i) => (
                  <li key={i} className={c.won ? "font-medium text-slate-900 dark:text-slate-100" : "text-slate-600 dark:text-slate-300"}>
                    {c.won ? "Shown: " : ""}
                    {c.name} ({c.playlistName}){c.note ? ` - ${c.note}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function DeviceCard({ screen, admin }: { screen: SignageScreen; admin: boolean }) {
  const d = screen.device;
  return (
    <section className="rounded-lg border border-slate-300 p-4 dark:border-slate-800">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Raspberry Pi</h2>
      {d ? (
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
          {admin ? (
            <Link href={`/signage/devices/${d.id}`} className="text-brand-600 underline dark:text-brand-400">
              {d.name}
            </Link>
          ) : (
            d.name
          )}{" "}
          at {d.ip}: {d.status !== "active" ? d.status.replace("_", " ") : d.online ? "answering" : <span className="font-medium text-rose-700 dark:text-rose-300">not answering</span>}
          {d.lastSeenAt ? <span className="text-slate-500 dark:text-slate-400"> (last heard {when(d.lastSeenAt)})</span> : null}
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          No Pi drives this screen yet.{" "}
          {admin ? (
            <Link href="/signage/devices?tab=found" className="text-brand-600 underline dark:text-brand-400">
              Set one up
            </Link>
          ) : null}
        </p>
      )}
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Schedule version {screen.manifestVersion ?? "none yet"}
        {screen.manifestDirty ? " (a change is being prepared)" : ""}
      </p>
    </section>
  );
}

function TvControls({ screen }: { screen: SignageScreen }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [input, setInput] = useState(screen.hdmiInput ?? "InputHDMI1");
  async function act(action: "on" | "off" | "input" | "state") {
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendJson<{ ok: boolean; message: string; via: string | null }>(`/api/signage/screens/${screen.id}/tv`, "POST", action === "input" ? { action, input } : { action });
      setMsg({ ok: r.ok, text: `${r.message}${r.via === "roku" ? " (sent straight to the Roku: the Pi did not answer)" : ""}` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-800">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">TV</h2>
      <p className="text-xs text-slate-500 dark:text-slate-400">These act on the real TV now. The power schedule puts it back at its next change.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnCls} disabled={busy} onClick={() => void act("on")}>
          <Power className="h-4 w-4" aria-hidden /> Switch on
        </button>
        <button type="button" className={dangerCls} disabled={busy} onClick={() => void act("off")}>
          <Power className="h-4 w-4" aria-hidden /> Switch off
        </button>
        <button type="button" className={btnCls} disabled={busy} onClick={() => void act("state")}>
          Ask the TV
        </button>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor={`${id}-in`}>Input</Label>
          <select id={`${id}-in`} className={inputCls} value={input} onChange={(e) => setInput(e.target.value as typeof input)}>
            {["InputHDMI1", "InputHDMI2", "InputHDMI3", "InputHDMI4"].map((i) => (
              <option key={i} value={i}>
                {i.replace("Input", "")}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={btnCls} disabled={busy} onClick={() => void act("input")}>
          Change input
        </button>
      </div>
      {msg ? <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{msg.text}</p> : null}
    </section>
  );
}
