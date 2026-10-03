"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Save, Plug, Plus, Trash2 } from "lucide-react";
import {
  type InfraTarget,
  type InfraOs,
  type InfraCapability,
  type InfraAuthType,
  type InfraThresholdRule,
  INFRA_OS,
  infraCapabilitiesForOs,
  infraMetricsForCapabilities,
  findInfraMetric,
} from "@church/shared";

type ThresholdRow = InfraThresholdRule;

/** Friendly labels for the comparison operators in the threshold editor. */
const OP_LABELS: Record<ThresholdRow["op"], string> = {
  ">": "is above",
  ">=": "is at or above",
  "<": "is below",
  "<=": "is at or below",
  "==": "equals",
};

const OS_LABELS: Record<InfraOs, string> = { linux: "Linux", mac: "macOS", windows: "Windows" };

/** Capabilities picked by default when creating a target for an OS. */
function defaultCapabilities(os: InfraOs): InfraCapability[] {
  return infraCapabilitiesForOs(os)
    .map((c) => c.key)
    .filter((k) => k === "cpu" || k === "memory" || k === "disk" || k === "load" || k === "updates");
}

export function InfraTargetForm({ initial }: { initial?: InfraTarget }) {
  const router = useRouter();
  const opts = (initial?.options ?? {}) as { port?: number; allowSelfSigned?: boolean };

  const [name, setName] = useState(initial?.name ?? "");
  const [os, setOs] = useState<InfraOs>(initial?.os ?? "linux");
  const [capabilities, setCapabilities] = useState<InfraCapability[]>(
    initial?.capabilities ?? defaultCapabilities(initial?.os ?? "linux"),
  );
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState<number | "">(opts.port ?? "");
  const [intervalSec, setIntervalSec] = useState(initial?.intervalSec ?? 30);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [allowSelfSigned, setAllowSelfSigned] = useState(opts.allowSelfSigned ?? true);

  const isHypervisor = capabilities.includes("hypervisor");
  // Transport (and therefore credential shape) is derived from the toggles.
  const [sshAuthType, setSshAuthType] = useState<InfraAuthType>(
    initial?.authType && initial.authType !== "proxmox_token" ? initial.authType : "ssh_key",
  );
  const authType: InfraAuthType = isHypervisor ? "proxmox_token" : sshAuthType;

  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [extra, setExtra] = useState("");
  const [caCert, setCaCert] = useState("");

  const [thresholds, setThresholds] = useState<ThresholdRow[]>(initial?.thresholds ?? []);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const availableCaps = infraCapabilitiesForOs(os);
  const defaultPort = isHypervisor ? 8006 : 22;

  function onOsChange(next: InfraOs) {
    setOs(next);
    // Drop capabilities the new OS doesn't offer; keep the rest.
    const allowed = new Set(infraCapabilitiesForOs(next).map((c) => c.key));
    setCapabilities((prev) => {
      const kept = prev.filter((c) => allowed.has(c));
      return kept.length ? kept : defaultCapabilities(next);
    });
  }

  function toggleCapability(key: InfraCapability) {
    setCapabilities((prev) => {
      if (prev.includes(key)) return prev.filter((c) => c !== key);
      let next = [...prev, key];
      // Hypervisor (Proxmox API) and docker (SSH) are different transports —
      // enabling one clears the other. "updates" only runs on the SSH path
      // too (see dispatch.ts), so it's dead weight on a hypervisor target.
      if (key === "hypervisor") next = next.filter((c) => c !== "docker" && c !== "updates");
      if (key === "docker") next = next.filter((c) => c !== "hypervisor");
      return next;
    });
  }

  function body(includeBlankCredential: boolean) {
    const credProvided = secret || username || extra || caCert || includeBlankCredential;
    return {
      name: name.trim(),
      os,
      capabilities,
      host: host.trim(),
      enabled,
      intervalSec,
      options: {
        // Preserve fields this form doesn't edit (ignoredMounts, watchedServices —
        // set from the target's detail page) instead of clobbering them on every save.
        ...(initial?.options ?? {}),
        port: port === "" ? undefined : Number(port),
        allowSelfSigned: isHypervisor ? allowSelfSigned : undefined,
        dockerTransport: capabilities.includes("docker") ? "ssh" : undefined,
      },
      thresholds,
      credential: credProvided
        ? {
            authType,
            username: username || undefined,
            secret: secret || undefined,
            extra: extra || undefined,
            caCert: caCert || undefined,
          }
        : undefined,
    };
  }

  async function runTest() {
    setTestMsg(null);
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/infra/targets/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(true)),
      });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setTestMsg({ ok: !!data.ok, text: data.message ?? (r.ok ? "OK" : `Failed (${r.status})`) });
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const url = initial ? `/api/infra/targets/${initial.id}` : "/api/infra/targets";
      const method = initial ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body(false)),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        setErr(Array.isArray(b.message) ? b.message.join(", ") : (b.message ?? `Request failed (${r.status})`));
        return;
      }
      const saved = (await r.json()) as InfraTarget;
      router.push(`/monitoring/infra/${saved.id}`);
    } finally {
      setBusy(false);
    }
  }

  const isSsh = !isHypervisor;
  const secretLabel = isHypervisor
    ? "API token secret"
    : authType === "ssh_key"
      ? "Private key (PEM)"
      : "Password";

  return (
    <form onSubmit={submit} className="mt-6 max-w-2xl space-y-5 text-sm">
      {/* Connection */}
      <fieldset className="space-y-4">
        <label className="block">
          <span className="text-xs text-slate-500">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="prod-node-01"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500">Operating system</span>
            <select
              value={os}
              onChange={(e) => onOsChange(e.target.value as InfraOs)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            >
              {INFRA_OS.map((o) => (
                <option key={o} value={o}>
                  {OS_LABELS[o]}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-slate-500">Host / IP</span>
            <input
              required
              value={host}
              onChange={(e) => setHost(e.target.value)}
              maxLength={255}
              placeholder={isHypervisor ? "pve.lan" : "10.0.0.5"}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500">Port (default {defaultPort})</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value === "" ? "" : parseInt(e.target.value, 10))}
              placeholder={String(defaultPort)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Poll interval (s)</span>
            <input
              type="number"
              min={10}
              max={86400}
              value={intervalSec}
              onChange={(e) => setIntervalSec(parseInt(e.target.value, 10) || 30)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="mt-6 inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
            />
            <span>Enabled</span>
          </label>
        </div>
      </fieldset>

      {/* Capabilities */}
      <fieldset className="space-y-2 rounded-md border border-slate-200 p-4 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Monitoring
        </legend>
        <p className="text-xs text-slate-500">
          Toggle what to monitor on this {OS_LABELS[os]} host. Each capability enables its own
          metrics (and any threshold alerts you set below).
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {availableCaps.map((c) => {
            const on = capabilities.includes(c.key);
            return (
              <label
                key={c.key}
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 transition ${
                  on
                    ? // Selected: a light blue that's never white and stays
                      // readable in both themes — same brand-100/900 steps as
                      // the @mention chip, for consistency.
                      "border-brand-400 bg-brand-100 dark:border-brand-700 dark:bg-brand-900/40"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleCapability(c.key)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
                />
                <span>
                  <span className="block font-medium">{c.label}</span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    {c.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Credentials */}
      <fieldset className="space-y-3 rounded-md border border-slate-200 p-4 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {isHypervisor ? "Proxmox API credential" : "SSH credential"}
        </legend>
        {initial?.hasCredential ? (
          <p className="text-xs text-slate-500">
            A credential is stored ({initial.authType}). Leave the secret blank to keep it unchanged.
          </p>
        ) : null}
        <p className="text-xs text-slate-500">
          {isHypervisor
            ? "Hypervisor monitoring uses the Proxmox REST API with an API token."
            : os === "windows"
              ? "Windows uses the OpenSSH Server feature; commands run via PowerShell."
              : "Connects over SSH."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {isSsh ? (
            <label className="block">
              <span className="text-xs text-slate-500">Auth type</span>
              <select
                value={sshAuthType}
                onChange={(e) => setSshAuthType(e.target.value as InfraAuthType)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="ssh_key">SSH key</option>
                <option value="ssh_password">SSH password</option>
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="text-xs text-slate-500">
              {isHypervisor ? "Token ID (user@realm!tokenid)" : "SSH username"}
            </span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={isHypervisor ? "monitor@pve!dashboard" : os === "windows" ? "Administrator" : "monitor"}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-slate-500">{secretLabel}</span>
          {authType === "ssh_key" ? (
            <textarea
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          ) : (
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          )}
        </label>
        {authType === "ssh_key" ? (
          <label className="block">
            <span className="text-xs text-slate-500">Key passphrase (optional)</span>
            <input
              type="password"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              autoComplete="new-password"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        ) : null}
        {isHypervisor ? (
          <>
            <label className="block">
              <span className="text-xs text-slate-500">CA certificate (optional, PEM)</span>
              <textarea
                value={caCert}
                onChange={(e) => setCaCert(e.target.value)}
                rows={3}
                placeholder="-----BEGIN CERTIFICATE-----"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={allowSelfSigned}
                onChange={(e) => setAllowSelfSigned(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
              />
              <span>Allow self-signed TLS</span>
            </label>
          </>
        ) : null}
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={runTest}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            <Plug className="h-4 w-4" aria-hidden /> Test connection
          </button>
          {testMsg ? (
            <span className={testMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
              {testMsg.text}
            </span>
          ) : null}
        </div>
      </fieldset>

      {/* Thresholds */}
      <ThresholdEditor rules={thresholds} onChange={setThresholds} capabilities={capabilities} />

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> {initial ? "Save changes" : "Add target"}
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
      </div>
    </form>
  );
}

function ThresholdEditor({
  rules,
  onChange,
  capabilities,
}: {
  rules: ThresholdRow[];
  onChange: (r: ThresholdRow[]) => void;
  capabilities: InfraCapability[];
}) {
  const metrics = infraMetricsForCapabilities(capabilities);

  function add() {
    // Seed from the first metric the enabled capabilities expose, with its
    // suggested operator + value, so a new rule is meaningful immediately.
    const m = metrics[0];
    onChange([
      ...rules,
      {
        id: `r${Date.now().toString(36)}`,
        entityKind: "target",
        metricPath: m?.path ?? "cpuPct",
        op: m?.suggestedOp ?? ">",
        value: m?.suggestedValue ?? 90,
        forSec: 120,
        severity: "warning",
      },
    ]);
  }
  function update(i: number, patch: Partial<ThresholdRow>) {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function pickMetric(i: number, path: string) {
    const m = findInfraMetric(path);
    update(i, m ? { metricPath: m.path, op: m.suggestedOp, value: m.suggestedValue } : { metricPath: path });
  }
  function remove(i: number) {
    onChange(rules.filter((_, idx) => idx !== i));
  }

  return (
    <fieldset className="space-y-3 rounded-md border border-slate-200 p-4 dark:border-slate-800">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Alert thresholds
      </legend>
      {metrics.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-400 dark:border-slate-700">
          Enable a metric capability above (CPU, memory, disk, load, or updates) to add threshold alerts.
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-500">
            Raise an alert when a metric stays past a limit for a sustained time — e.g.{" "}
            <em>CPU usage is above 90% for 120s</em>.
          </p>
          {rules.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-400 dark:border-slate-700">
              No thresholds yet. Add one to be alerted when this target is under strain.
            </p>
          ) : null}
          {rules.map((r, i) => {
            const def = findInfraMetric(r.metricPath);
            const unit = def?.unit ?? "";
            const showFallback = !metrics.some((m) => m.path === r.metricPath);
            return (
              <div key={r.id} className="space-y-1.5 rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-400">Metric</span>
                    <select
                      value={r.metricPath}
                      onChange={(e) => pickMetric(i, e.target.value)}
                      className="mt-0.5 block w-56 rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                    >
                      {metrics.map((m) => (
                        <option key={m.path} value={m.path}>
                          {m.label}
                          {m.unit ? ` (${m.unit})` : ""}
                        </option>
                      ))}
                      {showFallback ? <option value={r.metricPath}>{r.metricPath} (custom)</option> : null}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-400">Condition</span>
                    <select
                      value={r.op}
                      onChange={(e) => update(i, { op: e.target.value as ThresholdRow["op"] })}
                      className="mt-0.5 block rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                    >
                      {(Object.keys(OP_LABELS) as ThresholdRow["op"][]).map((o) => (
                        <option key={o} value={o}>
                          {OP_LABELS[o]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-400">Value{unit ? ` (${unit})` : ""}</span>
                    <input
                      type="number"
                      value={r.value}
                      onChange={(e) => update(i, { value: Number(e.target.value) })}
                      className="mt-0.5 block w-24 rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-400">Sustained (s)</span>
                    <input
                      type="number"
                      min={0}
                      value={r.forSec}
                      onChange={(e) => update(i, { forSec: Number(e.target.value) })}
                      className="mt-0.5 block w-24 rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase text-slate-400">Severity</span>
                    <select
                      value={r.severity}
                      onChange={(e) => update(i, { severity: e.target.value as ThresholdRow["severity"] })}
                      className="mt-0.5 block rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                    >
                      {["info", "warning", "critical"].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label="Remove rule"
                    className="rounded-md border border-slate-300 p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700 dark:hover:bg-rose-900/30"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                {def ? <p className="text-[11px] text-slate-400">{def.description}</p> : null}
              </div>
            );
          })}
          <button
            type="button"
            onClick={add}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add threshold
          </button>
        </>
      )}
    </fieldset>
  );
}
