"use client";

import { use, useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Camera, Cpu, KeyRound, RefreshCw } from "lucide-react";
import { SIGNAGE_TV_INPUTS, type SignageCommandInput, type SignageCommandResult, type SignageDevice, type SignageScreen, type SignageSetupRun } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { HoverTip, TipLink } from "@/components/hover-tip";
import { GoneNotice } from "@/components/gone-notice";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Modal } from "../../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, ProblemBadges, ago, btnCls, dangerCls, inputCls, primaryCls, useSignageJson, when } from "../../signage-ui";
import { RUN_KIND_TEXT, RUN_STATUS_TEXT, RunLog, SetupModal } from "../devices-ui";

/*
 * What the three maintenance buttons do, in the words a church volunteer needs. Keep these true to the code:
 * "Apply settings again" is a run of kind `apply` (SetupService.runApply), "Update the agent" a run of kind `agent_update`
 * (pushAgent with force), "Set up again" a run of kind `setup` (runSetup). docs/signage.md section 3 says the same.
 */
const APPLY_TIP = (
  <>
    <span className="block font-semibold">Make the Pi match the Signage settings</span>
    <span className="mt-1 block">
      Signs in with the dashboard&apos;s key and applies the current Security and system settings: the login account, SSH rules, firewall, read-only root, Wi-Fi, time server and
      the OS update window. Use it after you change one of those settings, or when this page says &quot;Settings: not yet applied&quot;.
    </span>
    <span className="mt-1 block">
      It also brings the agent up to date if it is behind. It does not change what the screen plays, and it restarts the Pi only if a boot setting needs it. If the dashboard can no
      longer log in afterwards, the Pi puts its SSH settings back within 2 minutes. Safe to repeat.
    </span>
    <span className="mt-2 block">
      <TipLink href="/signage/guide#device-buttons">More in the Signage guide</TipLink>
    </span>
  </>
);

const AGENT_TIP = (
  <>
    <span className="block font-semibold">Install the agent version this dashboard carries</span>
    <span className="mt-1 block">
      The agent is the small program on the Pi that plays the content, controls the TV and reports back. This copies the dashboard&apos;s current version over (checked against its
      hash), switches to it and restarts the agent, even if the Pi already shows the same version.
    </span>
    <span className="mt-1 block">If the new agent is not healthy within 2 minutes, the Pi goes back to the previous one by itself. Settings and content are not touched.</span>
    <span className="mt-2 block">
      <TipLink href="/signage/guide#device-buttons">More in the Signage guide</TipLink>
    </span>
  </>
);

const SETUP_AGAIN_TIP = (
  <>
    <span className="block font-semibold">Adopt the Pi again</span>
    <span className="mt-1 block">
      Runs the whole adoption from the beginning, as when the Pi was first added: it checks the Pi, installs or repairs the player and agent, puts the dashboard&apos;s key on it and
      applies the Security settings. You can change the name and screen, and give a different login for this Pi.
    </span>
    <span className="mt-1 block">
      Use it for a Pi whose adoption failed, that was re-flashed, or no longer answers to the dashboard. If the dashboard&apos;s key still works it is used and no password is needed; otherwise
      the saved setup login is tried. Available even while the Pi is not working.
    </span>
    <span className="mt-2 block">
      <TipLink href="/signage/guide#device-buttons">More in the Signage guide</TipLink>
    </span>
  </>
);

type Sample = { ts: string; cpuTempC: number | null; cpuPct?: number | null; wifiRssiDbm: number | null; diskFreeMb: number | null; memFreeMb: number | null };

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
  // What the TV itself said last (asked of the Pi live; "standby" is what the TV calls off). The button for the state it is already in is disabled.
  const [tvNow, setTvNow] = useState<{ power: "on" | "standby" | "unknown"; input: string | null; error: string | null } | null>(null);
  const [tvAsking, setTvAsking] = useState(false);
  const tvAsked = useRef(false);
  const tvTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const readTv = useCallback(async () => {
    setTvAsking(true);
    try {
      const r = await fetch(`/api/signage/devices/${id}/tv`, { credentials: "same-origin", cache: "no-store" });
      if (r.ok) setTvNow((await r.json()) as { power: "on" | "standby" | "unknown"; input: string | null; error: string | null });
      else setTvNow({ power: "unknown", input: null, error: `The TV could not be asked (${r.status}).` });
    } catch {
      setTvNow({ power: "unknown", input: null, error: "The TV could not be asked." });
    } finally {
      setTvAsking(false);
    }
  }, [id]);
  // Ask once when the page opens (and the Pi can be reached); afterwards after each TV command, or with "Ask the TV".
  const canAsk = device?.status === "active" && device.enabled;
  useEffect(() => {
    if (canAsk && !tvAsked.current) {
      tvAsked.current = true;
      void readTv();
    }
  }, [canAsk, readTv]);
  useEffect(
    () => () => {
      if (tvTimer.current) clearTimeout(tvTimer.current);
    },
    [],
  );

  async function command(c: SignageCommandInput, label: string, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(label);
    setResult(null);
    try {
      const r = await sendJson<SignageCommandResult>(`/api/signage/devices/${id}/command`, "POST", c);
      setResult({ ok: r.ok, text: r.message, output: c.type === "diag" ? r.output : undefined });
      if (c.type === "tv_state") {
        const o = r.output as { power?: string; input?: string | null } | undefined;
        setTvNow({ power: o?.power === "on" ? "on" : o?.power === "standby" ? "standby" : "unknown", input: o?.input ?? null, error: r.ok ? null : r.message });
      }
      if (c.type === "tv_power" && r.ok) {
        // Show what was asked for at once, then check what the TV says once it has had time to change.
        setTvNow({ power: c.state === "on" ? "on" : "standby", input: tvNow?.input ?? null, error: null });
        if (tvTimer.current) clearTimeout(tvTimer.current);
        tvTimer.current = setTimeout(() => void readTv(), 8000);
      }
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
    if (!device) return;
    const managed = device.keyGeneration !== null;
    const ask = managed
      ? `Forget ${device.name}? The dashboard first resets the Pi to a normal Raspberry Pi: its original login (user and password) works again, the dashboard's key, lock-down and player are removed, and it restarts (twice if the read-only root was on). Wi-Fi settings are kept.`
      : `Forget ${device.name}? The Pi keeps playing what it has until it is adopted again.`;
    if (!window.confirm(ask)) return;
    try {
      const r = await sendJson<{ reset?: boolean; runId?: string }>(`/api/signage/devices/${id}`, "DELETE");
      if (r?.reset && r.runId) {
        // The device stays until the dashboard sees the reset finish: watch it here.
        setResult({ ok: true, text: `${device.name} is being reset. It restarts once or twice over the next few minutes; it leaves the list once the dashboard sees that it is a normal Raspberry Pi again.` });
        setWatchRun(r.runId);
        void load();
        void runs.reload();
        return;
      }
      router.push("/signage/devices?tab=all");
    } catch (e) {
      const msg = (e as Error).message;
      if (managed && msg.startsWith("The Pi could not be reset") && window.confirm(`${msg}\n\nForget it anyway, without resetting it? It stays locked to the dashboard's key, and Adopt again finds it by that key.`)) {
        try {
          await sendJson(`/api/signage/devices/${id}?reset=0`, "DELETE");
          router.push("/signage/devices?tab=all");
          return;
        } catch (e2) {
          setResult({ ok: false, text: (e2 as Error).message });
          return;
        }
      }
      setResult({ ok: false, text: msg });
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
            <Row k="Playing" v={playingText(device)} />
            <Row k="Player" v={s?.playerRunning === undefined ? null : s.playerRunning ? "running" : "stopped"} />
            <Row k="TV" v={s?.tvPower ? `${s.tvPower}${s.tvInput ? `, ${s.tvInput}` : ""}${s.tvError ? ` (${s.tvError})` : ""}` : null} />
            <Row k="Content" v={`version ${device.manifestVersionApplied ?? "none"}${device.manifestVersionWanted && device.manifestVersionWanted !== device.manifestVersionApplied ? `, ${device.manifestVersionWanted} waiting` : ""}${s?.missingMedia ? `, ${s.missingMedia} files missing` : ""}`} />
            <Row k="Settings" v={device.settingsApplied ? "as chosen" : "not yet applied"} />
            <Row k="CPU" v={s?.cpuPct != null ? `${Math.round(s.cpuPct)}% busy` : null} />
            <Row k="Temperature" v={s?.cpuTempC != null ? `${fahrenheit(s.cpuTempC)} °F${s.underVoltage ? ", under-voltage" : ""}` : null} />
            <Row k="Disk free" v={s?.diskFreeMb != null ? `${(s.diskFreeMb / 1024).toFixed(1)} GB${s.diskTotalMb ? ` of ${(s.diskTotalMb / 1024).toFixed(1)}` : ""}` : null} />
            <Row k="Wi-Fi" v={s?.wifiSsid ? `${s.wifiSsid}${s.wifiRssiDbm != null ? `, ${s.wifiRssiDbm} dBm` : ""}${s.wifiBand ? `, ${s.wifiBand}` : ""}` : null} />
            <Row k="Clock" v={s?.clockSynced === undefined ? null : s.clockSynced ? "in sync" : "NOT in sync"} />
            <Row k="OS updates" v={s?.osUpdatesPending != null ? `${s.osUpdatesPending} waiting${s.osUpdateState ? ` (${s.osUpdateState})` : ""}` : null} />
            <Row k="Up for" v={s?.uptimeS != null ? humanUptime(s.uptimeS) : null} />
            <Row k="Serial" v={device.serial} />
            <Row k="MAC" v={[device.macEth, device.macWlan].filter(Boolean).join(", ") || null} />
          </dl>
          <SampleStrip samples={samples.data ?? []} />
          <CpuStrip samples={samples.data ?? []} />
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
        {!usable ? <p className="text-sm text-slate-600 dark:text-slate-300">{device.status === "resetting" ? "Being reset (Forget): the dashboard no longer manages this Pi." : device.enabled ? "Finish adopting the Pi first." : "The device is switched off: the dashboard does not sign in to it."}</p> : null}
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
          <button type="button" className={btnCls} disabled={!usable || busy !== null || tvNow?.power === "on"} aria-pressed={tvNow?.power === "on"} onClick={() => void command({ type: "tv_power", state: "on" }, "tvon")}>
            TV on
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null || tvNow?.power === "standby"} aria-pressed={tvNow?.power === "standby"} onClick={() => void command({ type: "tv_power", state: "off" }, "tvoff")}>
            TV off
          </button>
          <button type="button" className={btnCls} disabled={!usable || busy !== null || tvAsking} onClick={() => void command({ type: "tv_state" }, "tvstate")}>
            {tvAsking ? "Asking…" : "Ask the TV"}
          </button>
          <p role="status" className="self-center text-sm text-slate-700 dark:text-slate-200">
            {tvAsking && !tvNow
              ? "Asking the TV…"
              : tvNow
                ? tvNow.power === "on"
                  ? "The TV is on."
                  : tvNow.power === "standby"
                    ? "The TV is off (standby)."
                    : `The TV's power state is not known${tvNow.error ? `: ${tvNow.error}` : "."}`
                : null}
          </p>
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
          <HoverTip tip={APPLY_TIP}>
            <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void post<SignageSetupRun>("apply", "apply", (r) => { setWatchRun(r.id); return "Settings queued."; })}>
              Apply settings again
            </button>
          </HoverTip>
          <HoverTip tip={AGENT_TIP}>
            <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "agent_update" }, "agent")}>
              Update the agent
            </button>
          </HoverTip>
          <button type="button" className={btnCls} disabled={!usable || busy !== null} onClick={() => void command({ type: "os_update" }, "os", "Install OS updates now? The Pi may restart afterwards.")}>
            Install OS updates
          </button>
          <HoverTip tip={SETUP_AGAIN_TIP}>
            <button type="button" className={btnCls} disabled={busy !== null} onClick={() => setAgain(true)}>
              Adopt again
            </button>
          </HoverTip>
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
          Adoption and update runs
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

/** What the Pi is showing, in words ("Sunday loop: Welcome.jpg (Sunday service)"); null while it has reported nothing. */
function playingText(d: SignageDevice): string | null {
  const p = d.playing;
  if (!p) return d.latest?.playerRunning === false ? "nothing (the player is not running)" : null;
  if (p.kind === "logo") return "The logo slide (nothing is scheduled to play)";
  const list = p.playlistName ?? "a playlist that no longer exists";
  const item = p.mediaName ?? (d.latest?.nowPlaying?.media ? "a file not in the library" : "waiting for files");
  const from = p.kind === "fallback" ? " (fallback playlist)" : p.entryName ? ` (${p.entryName})` : "";
  return `${list}: ${item}${from}`;
}

/** The Pi reports Celsius; the page shows Fahrenheit (the bars' height and colour limits stay in Celsius). */
function fahrenheit(c: number): string {
  return (c * 1.8 + 32).toFixed(0);
}

/** Uptime in its two largest units: "45 s", "3 min 12 s", "2 h 5 min", "1 d 4 h". */
function humanUptime(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
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
      <figcaption className="text-xs text-slate-500 dark:text-slate-400">Temperature, last day (highest {fahrenheit(hi)} °F)</figcaption>
      <div className="mt-1 flex h-10 items-end gap-px" aria-hidden>
        {last.map((t) => {
          const v = t.cpuTempC ?? 0;
          return <span key={t.ts} title={`${when(t.ts)}: ${fahrenheit(v)} °F`} className={`flex-1 rounded-t-sm ${v >= 80 ? "bg-rose-500" : v >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />;
        })}
      </div>
    </figure>
  );
}

/** The last day's CPU use as small bars (0-100%, the whole bar height is 100%): a Pi that is flat out while decoding video shows here. */
function CpuStrip({ samples }: { samples: Sample[] }) {
  const used = samples.filter((x) => x.cpuPct != null);
  if (used.length < 2) return null;
  const last = used.slice(-96);
  const hi = Math.max(...last.map((t) => t.cpuPct ?? 0));
  return (
    <figure className="pt-2">
      <figcaption className="text-xs text-slate-500 dark:text-slate-400">CPU use, last day (highest {Math.round(hi)}%)</figcaption>
      <div className="mt-1 flex h-10 items-end gap-px" aria-hidden>
        {last.map((t) => {
          const v = Math.min(100, Math.max(0, t.cpuPct ?? 0));
          return <span key={t.ts} title={`${when(t.ts)}: ${Math.round(v)}%`} className={`flex-1 rounded-t-sm ${v >= 90 ? "bg-rose-500" : v >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ height: `${Math.max(4, v)}%` }} />;
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
