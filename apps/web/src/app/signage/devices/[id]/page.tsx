"use client";

import { use, useCallback, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Camera, Cpu, KeyRound, RefreshCw } from "lucide-react";
import { SIGNAGE_TV_INPUTS, type SignageCommandInput, type SignageCommandResult, type SignageDevice, type SignageScreen, type SignageSetupRun } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { GoneNotice } from "@/components/gone-notice";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Modal } from "../../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, ProblemBadges, ago, btnCls, dangerCls, inputCls, primaryCls, useSignageJson, when } from "../../signage-ui";
import { RUN_KIND_TEXT, RUN_STATUS_TEXT, RunLog, SetupModal } from "../devices-ui";

type Sample = { ts: string; cpuTempC: number | null; wifiRssiDbm: number | null; diskFreeMb: number | null; memFreeMb: number | null };

export default function SignageDevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [device, setDevice] = useState<SignageDevice | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "forbidden">("loading");
  const screens = useSignageJson<SignageScreen[]>("screens");
  const runs = useSignageJson<SignageSetupRun[]>(`devices/${id}/runs`);
  const samples = useSignageJson<Sample[]>(`devices/${id}/samples?hours=24`);
  const [result, setResult] = useState<{ ok: boolean; text: string; output?: unknown } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [watchRun, setWatchRun] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [again, setAgain] = useState(false);
  const [shotAt, setShotAt] = useState<number>(0);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [input, setInput] = useState<string>(SIGNAGE_TV_INPUTS[0]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/signage/devices/${id}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!r) return;
    if (r.status === 404 || r.status === 400) return setState("gone");
    if (r.status === 403) return setState("forbidden");
    if (r.ok) {
      setDevice((await r.json()) as SignageDevice);
      setState("ok");
    }
  }, [id]);
  usePoll(load, 15_000);

  async function command(c: SignageCommandInput, label: string, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(label);
    setResult(null);
    try {
      const r = await sendJson<SignageCommandResult>(`/api/signage/devices/${id}/command`, "POST", c);
      setResult({ ok: r.ok, text: r.message, output: c.type === "diag" ? r.output : undefined });
      const runId = (r.output as { runId?: string } | undefined)?.runId;
      if (runId) setWatchRun(runId);
      void load();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }
  async function post<T>(path: string, label: string, ok: (r: T) => string, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(label);
    setResult(null);
    try {
      const r = await sendJson<T>(`/api/signage/devices/${id}/${path}`, "POST");
      setResult({ ok: true, text: ok(r) });
      void load();
      void runs.reload();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }
  async function readLogs() {
    setBusy("logs");
    try {
      const r = await fetch(`/api/signage/devices/${id}/logs?lines=200`, { credentials: "same-origin", cache: "no-store" });
      const j = (await r.json().catch(() => null)) as { lines?: string[]; message?: string } | null;
      if (!r.ok) throw new Error(j?.message ?? `Could not read the logs (${r.status})`);
      setLogs(j?.lines ?? []);
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    if (!device || !window.confirm(`Forget ${device.name}? The Pi keeps playing what it has until it is set up again.`)) return;
    try {
      await sendJson(`/api/signage/devices/${id}`, "DELETE");
      router.push("/signage/devices?tab=all");
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  }

  if (state === "gone") return <GoneNotice what="device" backHref="/signage/devices" backLabel="Devices" />;
  if (state === "forbidden") return <Forbidden />;
  if (!device) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  const s = device.latest;
  const usable = device.status === "active" && device.enabled;
  const hostKeyProblem = device.problems.some((p) => p.code === "host_key");
  return (
    <div className="space-y-6">
      <Link href="/signage/devices" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Devices
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={Cpu}>{device.name}</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="font-mono">{device.ip}</span> · {!device.enabled ? "switched off" : device.online ? "online" : "offline"} · last seen {ago(device.lastSeenAt)}
            {device.screenId ? (
              <>
                {" "}· drives{" "}
                <Link href={`/signage/screens/${device.screenId}`} className="text-brand-600 underline dark:text-brand-400">
                  {device.screenName}
                </Link>
              </>
            ) : " · no screen"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnCls} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className={btnCls} onClick={() => void sendJson(`/api/signage/devices/${id}`, "PATCH", { enabled: !device.enabled }).then(load).catch((e: Error) => setResult({ ok: false, text: e.message }))}>
            {device.enabled ? "Switch off" : "Switch on"}
          </button>
          <button type="button" className={dangerCls} onClick={() => void remove()}>
            Forget
          </button>
        </div>
      </div>
      <ProblemBadges problems={device.problems} />
      {device.lastError ? <ErrorLine text={device.lastError} /> : null}
      {hostKeyProblem ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          <p>
            The Pi at this address showed a different SSH host key from the one recorded, so the dashboard did not sign in. That happens after the SD card is re-flashed or replaced, and also when another machine took the address.
          </p>
          <button type="button" className={`${dangerCls} mt-2`} onClick={() => void post("trust-host-key", "trust", () => "The next login records the key the Pi shows.", "Trust whatever key the Pi shows next? Only do this if you know the Pi was re-flashed.")}>
            <KeyRound className="h-4 w-4" aria-hidden /> Trust the new host key
          </button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="dev-status" className="space-y-2 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <h2 id="dev-status" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Status
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <Row k="Model" v={device.model ?? s?.model} />
            <Row k="OS" v={device.osRelease ?? s?.osVersion} />
            <Row k="Agent" v={device.agentVersion} />
            <Row k="Login" v={device.loginUser ? `${device.loginUser} (key ${device.keyGeneration ?? "?"})` : null} />
            <Row k="Playing" v={s?.nowPlaying ? [s.nowPlaying.playlist, s.nowPlaying.media].filter(Boolean).join(": ") || null : null} />
            <Row k="Player" v={s?.playerRunning === undefined ? null : s.playerRunning ? "running" : "stopped"} />
            <Row k="TV" v={s?.tvPower ? `${s.tvPower}${s.tvInput ? `, ${s.tvInput}` : ""}${s.tvError ? ` (${s.tvError})` : ""}` : null} />
            <Row k="Content" v={`version ${device.manifestVersionApplied ?? "none"}${device.manifestVersionWanted && device.manifestVersionWanted !== device.manifestVersionApplied ? `, ${device.manifestVersionWanted} waiting` : ""}${s?.missingMedia ? `, ${s.missingMedia} files missing` : ""}`} />
            <Row k="Settings" v={device.settingsApplied ? "as chosen" : "not yet applied"} />
            <Row k="Temperature" v={s?.cpuTempC != null ? `${s.cpuTempC.toFixed(0)} °C${s.underVoltage ? ", under-voltage" : ""}` : null} />
            <Row k="Disk free" v={s?.diskFreeMb != null ? `${(s.diskFreeMb / 1024).toFixed(1)} GB${s.diskTotalMb ? ` of ${(s.diskTotalMb / 1024).toFixed(1)}` : ""}` : null} />
            <Row k="Wi-Fi" v={s?.wifiSsid ? `${s.wifiSsid}${s.wifiRssiDbm != null ? `, ${s.wifiRssiDbm} dBm` : ""}${s.wifiBand ? `, ${s.wifiBand}` : ""}` : null} />
            <Row k="Clock" v={s?.clockSynced === undefined ? null : s.clockSynced ? "in sync" : "NOT in sync"} />
            <Row k="OS updates" v={s?.osUpdatesPending != null ? `${s.osUpdatesPending} waiting${s.osUpdateState ? ` (${s.osUpdateState})` : ""}` : null} />
            <Row k="Up for" v={s?.uptimeS != null ? `${Math.floor(s.uptimeS / 86400)} d ${Math.floor((s.uptimeS % 86400) / 3600)} h` : null} />
            <Row k="Serial" v={device.serial} />
            <Row k="MAC" v={[device.macEth, device.macWlan].filter(Boolean).join(", ") || null} />
          </dl>
          <SampleStrip samples={samples.data ?? []} />
        </section>

        <section aria-labelledby="dev-shot" className="space-y-2 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <h2 id="dev-shot" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              What the screen shows
            </h2>
            <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void post<{ takenAt: string }>("screenshot", "shot", () => { setShotAt(Date.now()); return "Picture taken."; })}>
              <Camera className="h-4 w-4" aria-hidden /> {busy === "shot" ? "Taking…" : "Take a picture"}
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/signage/devices/${id}/screenshot?t=${shotAt}`}
            alt={`Last picture of ${device.name}'s screen`}
            className="aspect-video w-full rounded-md bg-slate-950 object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
            onLoad={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "visible";
            }}
          />
        </section>
      </div>

      <section aria-labelledby="dev-actions" className="space-y-3 rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 id="dev-actions" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Do something
        </h2>
        {!usable ? <p className="text-sm text-slate-600 dark:text-slate-300">{device.enabled ? "Finish setting the Pi up first." : "The device is switched off: the dashboard does not sign in to it."}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "sync_now" }, "sync")}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Send content now
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "restart_player" }, "rp")}>
            Restart the player
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "restart_agent" }, "ra")}>
            Restart the agent
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "diag" }, "diag")}>
            Diagnostics
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void readLogs()}>
            Player logs
          </button>
          <button type="button" className={dangerCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "reboot" }, "reboot", `Restart ${device.name}? The screen goes blank for about a minute.`)}>
            Restart the Pi
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "tv_power", state: "on" }, "tvon")}>
            TV on
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "tv_power", state: "off" }, "tvoff")}>
            TV off
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "tv_state" }, "tvstate")}>
            Ask the TV
          </button>
          <span className="flex items-end gap-2">
            <span>
              <label htmlFor="dev-input" className="block text-xs text-slate-500 dark:text-slate-400">
                Input
              </label>
              <select id="dev-input" className={inputCls} value={input} onChange={(e) => setInput(e.target.value)}>
                {SIGNAGE_TV_INPUTS.map((i) => (
                  <option key={i} value={i}>
                    {i.replace("Input", "")}
                  </option>
                ))}
              </select>
            </span>
            <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "tv_input", input: input as (typeof SIGNAGE_TV_INPUTS)[number] }, "tvin")}>
              Switch input
            </button>
          </span>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void post<SignageSetupRun>("apply", "apply", (r) => { setWatchRun(r.id); return "Settings queued."; })}>
            Apply settings again
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "agent_update" }, "agent")}>
            Update the agent
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "os_update" }, "os", "Install OS updates now? The Pi may restart afterwards.")}>
            Install OS updates
          </button>
          <button type="button" className={btnCls} disabled={busy !== null} onClick={() => setAgain(true)}>
            Set up again
          </button>
        </div>
        {busy ? <p className="text-sm text-slate-500 dark:text-slate-400">Working…</p> : null}
        {result ? (
          <div role="status" className={`text-sm ${result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
            <p>{result.text}</p>
            {result.output !== undefined ? (
              <pre tabIndex={0} role="region" aria-label="Diagnostics" className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-100">
                {typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
        {watchRun ? <RunLog runId={watchRun} onFinished={() => void runs.reload()} /> : null}
      </section>

      <section aria-labelledby="dev-runs" className="space-y-2">
        <h2 id="dev-runs" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Setup and update runs
        </h2>
        {runs.data?.length ? (
          <ul className="space-y-1 text-sm">
            {runs.data.slice(0, 20).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800">
                <span>
                  {RUN_KIND_TEXT[r.kind]} · <span className={r.status === "failed" ? "text-rose-700 dark:text-rose-300" : ""}>{RUN_STATUS_TEXT[r.status]}</span> · {when(r.createdAt)}
                  {r.error ? <span className="block text-xs text-rose-700 dark:text-rose-300">{r.error}</span> : null}
                </span>
                <button type="button" className={btnCls} onClick={() => setWatchRun(r.id)} aria-label={`Show the log of the ${RUN_KIND_TEXT[r.kind]} run from ${when(r.createdAt)}`}>
                  Log
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">None yet.</p>
        )}
      </section>

      {logs ? (
        <Modal title={`${device.name}: player logs`} onClose={() => setLogs(null)}>
          <pre tabIndex={0} role="region" aria-label="Player logs" className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {logs.length ? logs.join("\n") : "(empty)"}
          </pre>
        </Modal>
      ) : null}
      {editing ? <EditDevice device={device} screens={screens.data ?? []} onClose={() => setEditing(false)} onSaved={(d) => { setDevice(d); setEditing(false); }} /> : null}
      {again ? (
        <SetupModal
          found={null}
          device={device}
          screens={screens.data ?? []}
          onClose={() => setAgain(false)}
          onDone={() => {
            setAgain(false);
            void load();
            void runs.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <>
      <dt className="text-slate-500 dark:text-slate-400">{k}</dt>
      <dd className="text-slate-900 dark:text-slate-100">{v ?? <span className="text-slate-500 dark:text-slate-400">not known</span>}</dd>
    </>
  );
}

/** The last day's temperature as small bars: enough to see a Pi that runs hot in the afternoon. */
function SampleStrip({ samples }: { samples: Sample[] }) {
  const temps = samples.filter((x) => x.cpuTempC != null);
  if (temps.length < 2) return null;
  const max = Math.max(85, ...temps.map((t) => t.cpuTempC ?? 0));
  const last = temps.slice(-96);
  const hi = Math.max(...last.map((t) => t.cpuTempC ?? 0));
  return (
    <figure className="pt-2">
      <figcaption className="text-xs text-slate-500 dark:text-slate-400">Temperature, last day (highest {hi.toFixed(0)} °C)</figcaption>
      <div className="mt-1 flex h-10 items-end gap-px" aria-hidden>
        {last.map((t) => {
          const v = t.cpuTempC ?? 0;
          return <span key={t.ts} title={`${when(t.ts)}: ${v.toFixed(0)} °C`} className={`flex-1 rounded-t-sm ${v >= 80 ? "bg-rose-500" : v >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />;
        })}
      </div>
    </figure>
  );
}

function EditDevice({ device, screens, onClose, onSaved }: { device: SignageDevice; screens: SignageScreen[]; onClose: () => void; onSaved: (d: SignageDevice) => void }) {
  const id = useId();
  const [name, setName] = useState(device.name);
  const [screenId, setScreenId] = useState<string>(device.screenId ?? "");
  const [err, setErr] = useState<string | null>(null);
  const free = screens.filter((s) => !s.device || s.device.id === device.id);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      onSaved(await sendJson<SignageDevice>(`/api/signage/devices/${device.id}`, "PATCH", { name: name.trim(), screenId: screenId || null }));
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title={`Edit ${device.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={`${id}-n`}>Name</Label>
          <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </div>
        <div>
          <Label htmlFor={`${id}-s`} hint="A screen has one Pi. Moving a Pi sends it the new screen's content.">
            Screen it drives
          </Label>
          <select id={`${id}-s`} className={inputCls} value={screenId} onChange={(e) => setScreenId(e.target.value)}>
            <option value="">None</option>
            {free.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <ErrorLine text={err} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryCls} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
