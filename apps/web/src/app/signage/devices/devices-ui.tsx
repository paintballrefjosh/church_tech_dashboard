"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, Loader2, X } from "lucide-react";
import type { SignageFoundPi, SignageScreen, SignageSetupRun } from "@lampstand/shared";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { restartsPi, parseRunSteps, stepInfo, stepStates, type StepState } from "@/lib/signage-run-steps";
import { ErrorLine, Label, btnCls, inputCls, primaryCls } from "../signage-ui";

export const RUN_KIND_TEXT: Record<SignageSetupRun["kind"], string> = {
  setup: "Adopt",
  apply: "Apply settings",
  os_update: "OS update",
  agent_update: "Agent update",
  show_code: "Show a code",
  forget: "Forget (reset)",
};

export const RUN_STATUS_TEXT: Record<SignageSetupRun["status"], string> = {
  queued: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  needs_sudo: "Needs a sudo password",
};

function runBusy(r: SignageSetupRun): boolean {
  return r.status === "queued" || r.status === "running";
}

/**
 * A setup (or apply, update) run as it happens: its log, read again every 2 s while it is going, and the sudo password
 * prompt when the Pi's login needs one. The password goes to the API for this run only and is never kept.
 */
export function RunLog({ runId, onFinished }: { runId: string; onFinished?: (run: SignageSetupRun) => void }) {
  const id = useId();
  const [run, setRun] = useState<SignageSetupRun | null>(null);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const finished = useRef(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const stepsRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const r = await fetch(`/api/signage/runs/${runId}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
      if (cancelled) return;
      if (r?.ok) {
        const next = (await r.json()) as SignageSetupRun;
        if (cancelled) return;
        setRun(next);
        if (!runBusy(next) && !finished.current) {
          finished.current = true;
          onFinished?.(next);
        }
        if (runBusy(next)) finished.current = false;
        if (!runBusy(next) && next.status !== "needs_sudo") return;
      }
      timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, onFinished]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    const live = stepsRef.current?.querySelector('[data-step-state="running"]');
    if (live && typeof live.scrollIntoView === "function") live.scrollIntoView({ block: "nearest" });
  }, [run?.output]);
  const steps = useMemo(() => (run ? stepStates(parseRunSteps(run.output), run.status, run.kind) : []), [run]);

  async function giveSudo(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const next = await sendJson<SignageSetupRun>(`/api/signage/runs/${runId}/sudo`, "POST", { sudoPassword: pw });
      setPw("");
      finished.current = false;
      setRun(next);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  if (!run) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-700 dark:text-slate-200">
        {RUN_KIND_TEXT[run.kind]} on {run.deviceName ?? run.ip}: <strong>{RUN_STATUS_TEXT[run.status]}</strong>
        {run.step && runBusy(run) ? ` (${stepInfo(run.step).label})` : ""}
      </p>
      {steps.length ? (
        <ol ref={stepsRef} tabIndex={0} role="region" aria-label="Steps" className="max-h-96 space-y-2 overflow-auto">
          {steps.map((s, n) => {
            const info = stepInfo(s.name);
            return (
              <li key={`${n}-${s.name}`} data-step-state={s.state} className={`rounded-md border border-l-4 border-slate-300 p-2 dark:border-slate-700 ${info.tone.edge} ${s.state === "waiting" ? "opacity-70" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${info.tone.pill}`}>{info.label}</span>
                  <StepStateText state={s.state} />
                </div>
                {info.what ? <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{info.what}</p> : null}
                {s.lines.length ? (
                  <ul className="mt-1 space-y-0.5 border-t border-slate-200 pt-1 font-mono text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
                    {s.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">(nothing yet)</p>
      )}
      {restartsPi(run.output) ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          The Pi is restarting to finish. The TV stays black for a minute or two while it boots, then shows the Pi&apos;s name until its first schedule arrives. The device page shows when it answers again.
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">Full log</summary>
        <pre
          ref={logRef}
          tabIndex={0}
          role="region"
          aria-label="Run log"
          className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-100"
        >
          {run.output || "(nothing yet)"}
        </pre>
      </details>
      {run.error ? <ErrorLine text={run.error} /> : null}
      {run.status === "needs_sudo" ? (
        <form onSubmit={giveSudo} className="space-y-2 rounded-md border border-amber-300 p-3 dark:border-amber-800">
          <Label htmlFor={`${id}-sudo`} hint="Used for this run only, never saved.">
            The Pi asked for the login&apos;s sudo password
          </Label>
          <div className="flex gap-2">
            <input id={`${id}-sudo`} type="password" autoComplete="off" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} required />
            <button type="submit" className={primaryCls} disabled={!pw}>
              Go on
            </button>
          </div>
          <ErrorLine text={err} />
        </form>
      ) : null}
    </div>
  );
}

function StepStateText({ state }: { state: StepState }) {
  const text = { done: "Done", running: "Working", failed: "Failed", waiting: "Waiting" }[state];
  const cls = {
    done: "text-emerald-700 dark:text-emerald-300",
    running: "text-brand-700 dark:text-brand-300",
    failed: "text-rose-700 dark:text-rose-300",
    waiting: "text-slate-500 dark:text-slate-400",
  }[state];
  const Icon = { done: Check, running: Loader2, failed: X, waiting: Circle }[state];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${cls}`}>
      <Icon className={`h-3.5 w-3.5 ${state === "running" ? "animate-spin" : ""}`} aria-hidden /> {text}
    </span>
  );
}

/** How long the adoption window stays up after the run succeeds, before it closes and opens the device's page. */
const AFTER_DONE_MS = 10_000;

/** Set up a found Pi (or an existing device again): name it, give it a screen, optionally a one-off login. */
export function SetupModal({
  found,
  device,
  screens,
  onClose,
  onDone,
}: {
  found: SignageFoundPi | null;
  device: { id: string; name: string; screenId: string | null } | null;
  screens: SignageScreen[];
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(device?.name ?? found?.name ?? "");
  const [screenChoice, setScreenChoice] = useState<string>(device?.screenId ?? "new");
  const [newScreen, setNewScreen] = useState(found?.name ?? "");
  const [ownLogin, setOwnLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [doneRun, setDoneRun] = useState<SignageSetupRun | null>(null);
  const router = useRouter();
  const free = screens.filter((s) => !s.device || s.device.id === device?.id);
  const openDeviceId = doneRun ? (doneRun.deviceId ?? device?.id ?? null) : null;

  // Once the run has succeeded: wait a moment (the last lines are worth reading), then close and open the device's page.
  // Closing the window by hand first cancels it (the effect's cleanup), so nothing navigates after the person has left.
  useEffect(() => {
    if (!doneRun) return;
    const t = setTimeout(() => finish(), AFTER_DONE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneRun]);

  // Stable, because RunLog polls again whenever this changes.
  const runFinished = useCallback((r: SignageSetupRun) => setDoneRun(r.status === "succeeded" ? r : null), []);

  function finish() {
    onDone();
    if (openDeviceId) router.push(`/signage/devices/${openDeviceId}`);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const body: Record<string, unknown> = found ? { foundId: found.id } : { deviceId: device?.id };
    if (name.trim()) body.name = name.trim();
    if (screenChoice === "new") {
      if (newScreen.trim()) body.newScreenName = newScreen.trim();
    } else if (screenChoice === "none") body.screenId = null;
    else body.screenId = screenChoice;
    if (ownLogin) {
      if (username.trim()) body.username = username.trim();
      if (password) body.password = password;
    }
    try {
      const run = await sendJson<SignageSetupRun>("/api/signage/setup", "POST", body);
      setPassword("");
      setRunId(run.id);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <Modal title={found ? `Adopt ${found.ip}` : `Adopt ${device?.name ?? ""} again`} onClose={runId ? onDone : onClose}>
      {runId ? (
        <div className="space-y-3">
          <RunLog runId={runId} onFinished={runFinished} />
          <div className="flex items-center justify-end gap-3">
            {doneRun && openDeviceId ? (
              <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
                Adopted. Opening the device page in a few seconds.
              </p>
            ) : null}
            <button type="button" className={doneRun ? primaryCls : btnCls} onClick={doneRun ? finish : onDone}>
              {doneRun ? "Done" : "Close"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            The dashboard signs in over SSH, installs the player, puts its own key on the Pi and applies the Security settings. Then it manages the Pi with that key only.
          </p>
          <div>
            <Label htmlFor={`${id}-n`}>Device name</Label>
            <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Foyer Pi" maxLength={120} />
          </div>
          <div>
            <Label htmlFor={`${id}-s`}>Screen it drives</Label>
            <select id={`${id}-s`} className={inputCls} value={screenChoice} onChange={(e) => setScreenChoice(e.target.value)}>
              <option value="new">A new screen</option>
              <option value="none">None for now</option>
              {free.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {screenChoice === "new" ? (
            <div>
              <Label htmlFor={`${id}-ns`}>New screen name</Label>
              <input id={`${id}-ns`} className={inputCls} value={newScreen} onChange={(e) => setNewScreen(e.target.value)} placeholder="Foyer" maxLength={120} required />
            </div>
          ) : null}
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={ownLogin} onChange={(e) => setOwnLogin(e.target.checked)} /> This Pi has a different login from the saved setup login
          </label>
          {ownLogin ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${id}-u`}>User name</Label>
                <input id={`${id}-u`} className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <Label htmlFor={`${id}-p`} hint="Used for this adoption only, never saved.">
                  Password
                </Label>
                <input id={`${id}-p`} type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              </div>
            </div>
          ) : null}
          <ErrorLine text={err} />
          <div className="flex justify-end gap-2">
            <button type="button" className={btnCls} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryCls}>
              Adopt
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Show the code a found Pi puts on its TV, to tell which Pi is which before setting it up. */
export function ShowCodeModal({ found, onClose }: { found: SignageFoundPi; onClose: () => void }) {
  const id = useId();
  const [ownLogin, setOwnLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  // What taking the code off the screen needs: the same login, and the console a desktop Pi was on before it was switched.
  const [clearBody, setClearBody] = useState<Record<string, string | number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** Closing the window takes the code off the TV (best effort: the request goes on after the window is gone). */
  function close() {
    if (code && clearBody) void sendJson(`/api/signage/discovery/found/${found.id}/clear-code`, "POST", clearBody).catch(() => undefined);
    setPassword("");
    onClose();
  }
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      if (ownLogin && username.trim()) body.username = username.trim();
      if (ownLogin && password) body.password = password;
      const r = await sendJson<{ code: string; desktop?: boolean; seconds?: number | null; vt?: number | null }>(`/api/signage/discovery/found/${found.id}/show-code`, "POST", body);
      // The typed password stays in this window (never saved) until it is closed: clearing the code signs in again.
      setClearBody({ ...body, ...(typeof r.vt === "number" ? { vt: r.vt } : r.desktop ? { vt: 7 } : {}) });
      setDesktop(r.desktop === true);
      setSeconds(typeof r.seconds === "number" ? r.seconds : null);
      setCode(r.code);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Show a code on ${found.ip}`} onClose={close}>
      {code ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-slate-600 dark:text-slate-300">Look for this on the TVs:</p>
          <p className="font-mono text-5xl font-bold tracking-widest text-slate-900 dark:text-slate-100">{code}</p>
          {seconds ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              This Pi is already adopted, so the code is drawn by its player for {seconds} seconds. If the TV shows nothing, the player is not running or the TV is off or on another input.
            </p>
          ) : null}
          {desktop ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              This Pi runs the full desktop, so its screen was switched to the text console to show the code. Closing this window switches it back to the desktop. Setting it up makes it boot to the console.
            </p>
          ) : null}
          <p className="text-sm text-slate-600 dark:text-slate-300">The code is taken off the screen when you close this window.</p>
          <button type="button" className={btnCls} onClick={close}>
            Close
          </button>
        </div>
      ) : (
        <form onSubmit={go} className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">The dashboard signs in (with its own key on a Pi it has adopted, else the setup login) and puts a 3-digit code on the Pi&apos;s text console (the screen a Pi shows when it has no desktop) and leaves it there until you close this window. Nothing is installed.</p>
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={ownLogin} onChange={(e) => setOwnLogin(e.target.checked)} /> Use another login for this Pi
          </label>
          {ownLogin ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${id}-u`}>User name</Label>
                <input id={`${id}-u`} className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <Label htmlFor={`${id}-p`}>Password</Label>
                <input id={`${id}-p`} type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              </div>
            </div>
          ) : null}
          <ErrorLine text={err} />
          <div className="flex justify-end gap-2">
            <button type="button" className={btnCls} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryCls} disabled={busy}>
              {busy ? "Signing in…" : "Show the code"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
