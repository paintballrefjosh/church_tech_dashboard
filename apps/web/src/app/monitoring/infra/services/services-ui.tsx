"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, CircleCheck, FlaskConical, Loader2, Search, Terminal } from "lucide-react";
import {
  SAVED_SECRET,
  SERVICE_INTERVAL,
  serviceInputProblems,
  templateCommands,
  templateRunsCommands,
  type ServiceInputValue,
  type ServiceInstance,
  type ServiceInstanceStatus,
  type ServiceLogin,
  type ServiceMetric,
  type ServiceTemplate,
  type ServiceTemplateBody,
  type ServiceTestResult,
} from "@church/shared";
import { DialogFrame } from "@/components/modal";
import { errorText } from "@/components/assets-ui";
import { inputCls } from "../../network-cisco/cisco-ui";

/**
 * Shared pieces of service monitoring in the web (docs/service-monitoring.md): the request helper that understands the
 * "confirm these commands" answer, the status pill, value formatting, the Test result view and the add/edit dialog.
 */

export const SVC_API = "/api/service-monitoring";

/** The API wants the commands a template runs on the host confirmed (409 `confirm_commands`). */
export class ConfirmCommandsNeeded extends Error {
  constructor(message: string, readonly commands: string[]) {
    super(message);
  }
}

export async function svcSend<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(`${SVC_API}${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => null)) as { code?: string; commands?: string[]; message?: string } | null;
  if (r.status === 409 && json?.code === "confirm_commands") throw new ConfirmCommandsNeeded(String(json.message ?? ""), json.commands ?? []);
  if (!r.ok) throw new Error(errorText(json, r.status));
  return json as T;
}

export async function svcGet<T>(path: string): Promise<T | null> {
  const r = await fetch(`${SVC_API}${path}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
  return r?.ok ? ((await r.json()) as T) : null;
}

const STATUS: Record<ServiceInstanceStatus, { label: string; cls: string }> = {
  up: { label: "Up", cls: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  degraded: { label: "Warning", cls: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  down: { label: "Down", cls: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300" },
  unknown: { label: "Not checked yet", cls: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" },
  disabled: { label: "Switched off", cls: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" },
};

export function ServiceStatusPill({ status }: { status: ServiceInstanceStatus }) {
  const s = STATUS[status] ?? STATUS.unknown;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export function metricLabel(key: string, m: ServiceMetric | undefined): string {
  return m?.label ?? key.replace(/_/g, " ");
}

/** A metric's value as text: whole numbers plain, others to three significant figures, with the template's unit. */
export function formatMetric(v: number | null | undefined, m: ServiceMetric | undefined): string {
  if (v === null || v === undefined) return "-";
  const n = Number.isInteger(v) ? v.toLocaleString() : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number(v.toPrecision(3)).toString();
  const unit = m?.unit ?? "";
  if (!unit) return n;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

/** The cards a template asks for, else its first six numeric metrics. */
export function cardKeys(body: ServiceTemplateBody | null, values: Record<string, number | null>, states: Record<string, string | null>): string[] {
  if (body?.display?.cards?.length) return body.display.cards;
  const keys = body ? Object.keys(body.metrics) : [...Object.keys(states), ...Object.keys(values)];
  return keys.slice(0, 6);
}

export const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
};

export const btnCls =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800";
export const primaryBtnCls =
  "inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60";
export const labelCls = "text-xs font-medium text-slate-600 dark:text-slate-300";
export const helpCls = "text-xs text-slate-500 dark:text-slate-400";

/** The commands a template runs on the host, shown before anyone may save it or attach it. */
export function CommandList({ commands }: { commands: string[] }) {
  return (
    <ul className="space-y-1 rounded-md border border-slate-300 bg-slate-950 p-3 font-mono text-xs text-slate-100 dark:border-slate-700" aria-label="Commands run on the host">
      {commands.map((c) => (
        <li key={c} className="whitespace-pre-wrap break-all">
          {c}
        </li>
      ))}
    </ul>
  );
}

export function ConfirmCommandsBox({
  commands,
  checked,
  onChange,
  where = "this host",
}: {
  commands: string[];
  checked: boolean;
  onChange: (v: boolean) => void;
  where?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
      <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900 dark:text-amber-200">
        <Terminal className="h-4 w-4" aria-hidden /> This template runs these commands on {where} over SSH, on every check
      </p>
      <CommandList commands={commands} />
      <label htmlFor={id} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
        I have read these commands and they may run on {where}.
      </label>
    </div>
  );
}

/** What one Test run found: each collector (time, error, raw output, parsed rows), then values, states, checks, members. */
export function TestResultView({ result, body }: { result: ServiceTestResult; body: ServiceTemplateBody | null }) {
  return (
    <div className="space-y-3 text-sm" data-testid="service-test-result">
      {result.problems.length ? (
        <ul className="list-disc space-y-0.5 rounded-md border border-rose-300 bg-rose-50 p-3 pl-6 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          {result.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {result.collectors.map((c) => (
        <details key={c.name} className="rounded-md border border-slate-300 dark:border-slate-700" open={!!c.error}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
            {c.error ? <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400" aria-hidden /> : <CircleCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden />}
            <span className="font-medium">{c.name}</span>
            <span className={helpCls}>
              {c.transport} · {c.ms} ms · {c.error ? "failed" : `${c.rows} row${c.rows === 1 ? "" : "s"}`}
            </span>
          </summary>
          <div className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
            {c.error ? <p className="text-rose-700 dark:text-rose-300">{c.error}</p> : null}
            {c.raw !== null ? (
              <div>
                <p className={labelCls}>What the host answered</p>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-950" tabIndex={0} aria-label={`Raw output of ${c.name}`}>
                  {c.raw || "(nothing)"}
                </pre>
              </div>
            ) : null}
            {c.sample.length ? (
              <div>
                <p className={labelCls}>Rows as read (first {c.sample.length})</p>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-950" tabIndex={0} aria-label={`Parsed rows of ${c.name}`}>
                  {c.sample.map((r) => JSON.stringify(r)).join("\n")}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      ))}
      {!result.problems.length ? (
        <>
          <p className={result.down ? "font-medium text-rose-700 dark:text-rose-300" : "font-medium text-emerald-700 dark:text-emerald-400"}>
            {result.down ? "It would be marked down." : "It would be marked up."}
          </p>
          <ValueGrid body={body} values={result.values} states={result.states} />
          {result.checks.length ? (
            <ul className="space-y-1">
              {result.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  {c.breaching ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />}
                  <span>
                    <span className="font-medium">{c.id}</span> ({c.severity}): {c.breaching ? c.text : "fine"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {result.members.length ? <p className={helpCls}>{result.members.length} members read ({result.members.filter((m) => m.ok === false).length} not healthy).</p> : null}
        </>
      ) : null}
    </div>
  );
}

/** Every metric and state as a small table (the Test view and the instance page's "all values"). */
export function ValueGrid({ body, values, states }: { body: ServiceTemplateBody | null; values: Record<string, number | null>; states: Record<string, string | null> }) {
  const keys = [...Object.keys(states), ...Object.keys(values)];
  if (!keys.length) return <p className={helpCls}>No values.</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      {keys.map((k) => (
        <div key={k} className="flex justify-between gap-3 border-b border-slate-200 py-1 dark:border-slate-800">
          <dt className="text-slate-600 dark:text-slate-300">{metricLabel(k, body?.metrics[k])}</dt>
          <dd className="font-mono">{k in states ? (states[k] ?? "-") : formatMetric(values[k], body?.metrics[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

function isLogin(v: ServiceInputValue | undefined): v is { loginId: string } {
  return typeof v === "object" && v !== null && "loginId" in v;
}

type Suggestion = { key: string; unit: string; name: string; attached: boolean };

/**
 * Add a service to a host, or edit one: the template (with suggestions from the host's units), inputs drawn from the
 * template, the check interval, a Test run and, for a template that runs commands, the confirmation.
 */
export function ServiceFormModal({
  targetId,
  instance,
  onClose,
  onSaved,
}: {
  targetId: string;
  instance?: ServiceInstance;
  onClose: () => void;
  onSaved: (s: ServiceInstance) => void;
}) {
  const titleId = useId();
  const baseId = useId();
  const [templates, setTemplates] = useState<ServiceTemplate[] | null>(null);
  const [logins, setLogins] = useState<ServiceLogin[]>([]);
  const [templateKey, setTemplateKey] = useState(instance?.templateKey ?? "");
  const [name, setName] = useState(instance?.name ?? "");
  const [inputs, setInputs] = useState<Record<string, ServiceInputValue>>(instance?.inputs ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>(instance?.secrets ?? {});
  const [intervalSec, setIntervalSec] = useState(instance?.intervalSec ?? 60);
  const [confirmed, setConfirmed] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ServiceTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void svcGet<ServiceTemplate[]>("/templates").then((t) => setTemplates(t ?? []));
    void svcGet<ServiceLogin[]>("/logins").then((l) => setLogins(l ?? []));
  }, []);

  const template = templates?.find((t) => t.key === templateKey) ?? null;
  const body = template?.body ?? null;
  const commands = useMemo(() => (body && templateRunsCommands(body) ? templateCommands(body) : []), [body]);

  function pick(key: string) {
    setTemplateKey(key);
    setTest(null);
    setConfirmed(false);
    const t = templates?.find((x) => x.key === key);
    if (!instance) {
      setInputs({});
      setSecrets({});
      if (t && !name) setName(t.body.name);
    }
  }

  const secretKeys = new Set(Object.entries(secrets).filter(([, v]) => v !== "").map(([k]) => k));
  const problems = body ? serviceInputProblems(body, inputs, secretKeys) : ["Choose a template"];
  // Editing: inputs are sent only when they changed, because sending them means confirming the commands again.
  const inputsChanged = !instance || JSON.stringify(instance.inputs) !== JSON.stringify(inputs) || instance.templateKey !== templateKey;
  const needsConfirm = commands.length > 0 && inputsChanged;

  async function suggest() {
    setSuggesting(true);
    setErr(null);
    try {
      setSuggestions(await svcSend<Suggestion[]>(`/targets/${targetId}/suggestions`, "POST"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setErr(null);
    try {
      setTest(await svcSend<ServiceTestResult>("/test", "POST", {
        targetId,
        templateKey,
        inputs,
        secrets,
        instanceId: instance?.id,
        confirmCommands: commands.length && confirmed ? commands : undefined,
      }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    const confirmCommands = needsConfirm && confirmed ? commands : undefined;
    try {
      const saved = instance
        ? await svcSend<ServiceInstance>(`/instances/${instance.id}`, "PATCH", { name, inputs: inputsChanged ? inputs : undefined, secrets, intervalSec, confirmCommands })
        : await svcSend<ServiceInstance>("/instances", "POST", { targetId, templateKey, name, inputs, secrets, intervalSec, confirmCommands });
      onSaved(saved);
    } catch (e) {
      if (e instanceof ConfirmCommandsNeeded) {
        setConfirmed(false);
        setErr("The commands changed since this was opened: read them again and confirm.");
      } else setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogFrame
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      testId="service-form"
    >
      <h2 id={titleId} className="mb-3 text-base font-semibold">
        {instance ? `Edit ${instance.name}` : "Add a service to monitor"}
      </h2>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="space-y-1">
          <label htmlFor={`${baseId}-tpl`} className={labelCls}>
            Template
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              id={`${baseId}-tpl`}
              value={templateKey}
              disabled={!!instance || templates === null}
              onChange={(e) => pick(e.target.value)}
              className={`${inputCls} min-w-0 flex-1`}
            >
              <option value="">{templates === null ? "Loading…" : "Choose…"}</option>
              {templates?.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.body.name}
                  {t.source === "custom" ? " (custom)" : ""}
                </option>
              ))}
            </select>
            {!instance ? (
              <button type="button" onClick={() => void suggest()} disabled={suggesting} className={btnCls}>
                {suggesting ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />} What runs on this host?
              </button>
            ) : null}
          </div>
          {suggestions ? (
            suggestions.length ? (
              <ul className="flex flex-wrap gap-2 pt-1" aria-label="Templates that match this host">
                {suggestions.map((s) => (
                  <li key={s.key}>
                    <button type="button" onClick={() => pick(s.key)} className="rounded-full border border-brand-300 px-2.5 py-0.5 text-xs text-brand-700 hover:bg-brand-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-slate-800">
                      {s.name} <span className="text-slate-600 dark:text-slate-300">({s.unit}{s.attached ? ", already added" : ""})</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={helpCls}>No template matches a service running on this host.</p>
            )
          ) : null}
          {body?.description ? <p className={helpCls}>{body.description}</p> : null}
          {body?.needs ? <p className="text-xs text-slate-600 dark:text-slate-300">Needs: {body.needs}</p> : null}
        </div>

        {body ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`${baseId}-name`} className={labelCls}>
                  Name
                </label>
                <input id={`${baseId}-name`} value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full`} maxLength={120} required />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${baseId}-interval`} className={labelCls}>
                  Check every (seconds)
                </label>
                <input
                  id={`${baseId}-interval`}
                  type="number"
                  min={SERVICE_INTERVAL.min}
                  max={SERVICE_INTERVAL.max}
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(Number(e.target.value))}
                  className={`${inputCls} w-full`}
                />
              </div>
              {body.inputs.map((i) => {
                const id = `${baseId}-in-${i.key}`;
                const helpId = i.help ? `${id}-help` : undefined;
                const v = inputs[i.key];
                const set = (nv: ServiceInputValue | undefined) =>
                  setInputs((cur) => {
                    const next = { ...cur };
                    if (nv === undefined || nv === "") delete next[i.key];
                    else next[i.key] = nv;
                    return next;
                  });
                let field: React.ReactNode;
                if (i.type === "secret") {
                  const saved = secrets[i.key] === SAVED_SECRET;
                  field = (
                    <input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      aria-describedby={helpId}
                      value={saved ? "" : (secrets[i.key] ?? "")}
                      placeholder={saved ? "saved (type to replace)" : ""}
                      onChange={(e) => setSecrets((cur) => ({ ...cur, [i.key]: e.target.value === "" && instance?.secrets[i.key] ? SAVED_SECRET : e.target.value }))}
                      className={`${inputCls} w-full`}
                    />
                  );
                } else if (i.type === "login") {
                  field = (
                    <select id={id} aria-describedby={helpId} value={isLogin(v) ? v.loginId : ""} onChange={(e) => set(e.target.value ? { loginId: e.target.value } : undefined)} className={`${inputCls} w-full`}>
                      <option value="">{logins.length ? "Choose a saved login…" : "No saved logins (add one under Service templates > Logins)"}</option>
                      {logins.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name} ({l.username})
                        </option>
                      ))}
                    </select>
                  );
                } else if (i.type === "bool") {
                  const on = v === undefined ? i.default === true || i.default === "true" : v === true || v === "true";
                  field = (
                    <span className="flex items-center gap-2 pt-1 text-sm">
                      <input id={id} type="checkbox" aria-describedby={helpId} checked={on} onChange={(e) => set(e.target.checked)} /> yes
                    </span>
                  );
                } else if (i.type === "select") {
                  field = (
                    <select id={id} aria-describedby={helpId} value={typeof v === "string" ? v : String(i.default ?? "")} onChange={(e) => set(e.target.value)} className={`${inputCls} w-full`}>
                      {i.default === undefined ? <option value="">Choose…</option> : null}
                      {(i.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  );
                } else if (i.type === "text") {
                  field = (
                    <textarea id={id} aria-describedby={helpId} rows={3} value={typeof v === "string" ? v : ""} placeholder={i.default !== undefined ? String(i.default) : ""} onChange={(e) => set(e.target.value)} className={`${inputCls} w-full font-mono`} />
                  );
                } else {
                  field = (
                    <input
                      id={id}
                      aria-describedby={helpId}
                      inputMode={i.type === "number" ? "decimal" : undefined}
                      value={typeof v === "object" || v === undefined ? "" : String(v)}
                      placeholder={i.default !== undefined ? String(i.default) : ""}
                      onChange={(e) => set(i.type === "number" && e.target.value !== "" && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value)}
                      className={`${inputCls} w-full`}
                    />
                  );
                }
                return (
                  <div key={i.key} className={`space-y-1 ${i.type === "text" ? "sm:col-span-2" : ""}`}>
                    <label htmlFor={id} className={labelCls}>
                      {i.label}
                      {i.required ? <span className="text-rose-700 dark:text-rose-400"> *</span> : null}
                    </label>
                    {field}
                    {i.help ? (
                      <p id={helpId} className={helpCls}>
                        {i.help}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* A Test run runs the commands too, so the box shows whenever there are commands (saving an edit asks only when the inputs changed). */}
            {commands.length ? <ConfirmCommandsBox commands={commands} checked={confirmed} onChange={setConfirmed} /> : null}

            <div className="space-y-2">
              <button type="button" onClick={() => void runTest()} disabled={testing || problems.length > 0 || (commands.length > 0 && !confirmed)} className={btnCls}>
                {testing ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />} {testing ? "Testing…" : "Test against this host"}
              </button>
              {test ? <TestResultView result={test} body={body} /> : null}
            </div>
          </>
        ) : null}

        {body && problems.length ? (
          <ul className="list-disc pl-5 text-xs text-slate-600 dark:text-slate-300" aria-label="Still needed">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {err ? (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {err}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnCls}>
            Cancel
          </button>
          <button type="submit" disabled={saving || problems.length > 0 || !name.trim() || (needsConfirm && !confirmed)} className={primaryBtnCls}>
            {saving ? "Saving…" : instance ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
