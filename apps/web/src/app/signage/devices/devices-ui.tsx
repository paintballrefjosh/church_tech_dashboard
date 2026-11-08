"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SignageFoundPi, SignageScreen, SignageSetupRun } from "@lampstand/shared";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Label, btnCls, inputCls, primaryCls } from "../signage-ui";

export const RUN_KIND_TEXT: Record<SignageSetupRun["kind"], string> = {
  setup: "Set up",
  apply: "Apply settings",
  os_update: "OS update",
  agent_update: "Agent update",
  show_code: "Show a code",
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
  }, [run?.output]);

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
        {run.step && runBusy(run) ? ` (${run.step})` : ""}
      </p>
      <pre
        ref={logRef}
        tabIndex={0}
        role="region"
        aria-label="Run log"
        aria-live="polite"
        className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-100"
      >
        {run.output || "(nothing yet)"}
      </pre>
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
  const free = screens.filter((s) => !s.device || s.device.id === device?.id);

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
    <Modal title={found ? `Set up ${found.ip}` : `Set up ${device?.name ?? ""} again`} onClose={runId ? onDone : onClose}>
      {runId ? (
        <div className="space-y-3">
          <RunLog runId={runId} />
          <div className="flex justify-end">
            <button type="button" className={btnCls} onClick={onDone}>
              Close
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
                <Label htmlFor={`${id}-p`} hint="Used for this setup only, never saved.">
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
              Set it up
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      if (ownLogin && username.trim()) body.username = username.trim();
      if (ownLogin && password) body.password = password;
      const r = await sendJson<{ code: string }>(`/api/signage/discovery/found/${found.id}/show-code`, "POST", body);
      setPassword("");
      setCode(r.code);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Show a code on ${found.ip}`} onClose={onClose}>
      {code ? (
        <div className="space-y-3 text-center">
          <p className="text-sm text-slate-600 dark:text-slate-300">Look for this on the TVs:</p>
          <p className="font-mono text-5xl font-bold tracking-widest text-slate-900 dark:text-slate-100">{code}</p>
          <button type="button" className={btnCls} onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <form onSubmit={go} className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">The dashboard signs in with the setup login and puts a 3-digit code on the Pi&apos;s screen for a few minutes. Nothing is installed.</p>
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
