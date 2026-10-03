"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Save } from "lucide-react";
import { DNS_RECORD_TYPES, type Monitor } from "@church/shared";

type Kind = "http" | "tcp" | "icmp" | "tls" | "dns";

type Rec = Record<string, unknown>;
const optStr = (o: Rec, k: string, d = ""): string => (typeof o[k] === "string" ? (o[k] as string) : d);
const optNum = (o: Rec, k: string, d: number): number => (typeof o[k] === "number" ? (o[k] as number) : d);

export function MonitorForm({ initial }: { initial?: Monitor }) {
  const router = useRouter();
  const o = (initial?.options ?? {}) as Rec;
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Kind>((initial?.kind as Kind) ?? "http");
  const [target, setTarget] = useState(initial?.target ?? "");
  const [intervalSec, setIntervalSec] = useState(initial?.intervalSec ?? 60);
  const [failThreshold, setFailThreshold] = useState(initial?.failThreshold ?? 2);
  const [recoverThreshold, setRecoverThreshold] = useState(initial?.recoverThreshold ?? 2);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  // Per-kind options (only the ones relevant to the selected kind are submitted).
  const [httpMethod, setHttpMethod] = useState(optStr(o, "method", "GET"));
  const [httpExpectedStatus, setHttpExpectedStatus] = useState(optNum(o, "expectedStatus", 200));
  const [httpExpectBody, setHttpExpectBody] = useState(optStr(o, "expectBody"));
  const [tlsPort, setTlsPort] = useState(optNum(o, "port", 443));
  const [tlsWarnDays, setTlsWarnDays] = useState(optNum(o, "warnDays", 21));
  const [dnsRecordType, setDnsRecordType] = useState(optStr(o, "recordType", "A"));
  const [dnsExpectedValue, setDnsExpectedValue] = useState(optStr(o, "expectedValue"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function buildOptions(): Rec {
    switch (kind) {
      case "http": {
        const opts: Rec = { method: httpMethod, expectedStatus: httpExpectedStatus };
        if (httpExpectBody.trim()) opts.expectBody = httpExpectBody.trim();
        return opts;
      }
      case "tls":
        return { port: tlsPort, warnDays: tlsWarnDays };
      case "dns": {
        const opts: Rec = { recordType: dnsRecordType };
        if (dnsExpectedValue.trim()) opts.expectedValue = dnsExpectedValue.trim();
        return opts;
      }
      default:
        return {};
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: name.trim(),
        kind,
        target: target.trim(),
        intervalSec,
        failThreshold,
        recoverThreshold,
        enabled,
        options: buildOptions(),
      });
      const url = initial ? `/api/monitors/${initial.id}` : "/api/monitors";
      const method = initial ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        const msg = Array.isArray(body.message) ? body.message.join(", ") : body.message;
        setErr(msg ?? `Request failed (${r.status})`);
        return;
      }
      const saved = (await r.json()) as Monitor;
      router.push(`/monitoring/${saved.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4 text-sm">
      <label className="block">
        <span className="text-xs text-slate-500">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          placeholder="Front door web server"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-slate-500">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="http">HTTP</option>
            <option value="tcp">TCP</option>
            <option value="icmp">ICMP (ping)</option>
            <option value="tls">TLS cert expiry</option>
            <option value="dns">DNS</option>
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-slate-500">Target</span>
          <input
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            maxLength={500}
            placeholder={
              kind === "http"
                ? "https://example.com/status"
                : kind === "tcp"
                ? "host.example.com:443"
                : kind === "tls"
                ? "example.com"
                : kind === "dns"
                ? "example.com"
                : "host.example.com"
            }
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      </div>

      {kind === "http" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500">Method</span>
            <select
              value={httpMethod}
              onChange={(e) => setHttpMethod(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
              <option value="POST">POST</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Expected status</span>
            <input
              type="number"
              min={100}
              max={599}
              value={httpExpectedStatus}
              onChange={(e) => setHttpExpectedStatus(parseInt(e.target.value, 10) || 200)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Body contains (optional)</span>
            <input
              value={httpExpectBody}
              onChange={(e) => setHttpExpectBody(e.target.value)}
              maxLength={500}
              placeholder="OK"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
      ) : null}

      {kind === "tls" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={tlsPort}
              onChange={(e) => setTlsPort(parseInt(e.target.value, 10) || 443)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Warn when days left ≤</span>
            <input
              type="number"
              min={1}
              max={365}
              value={tlsWarnDays}
              onChange={(e) => setTlsWarnDays(parseInt(e.target.value, 10) || 21)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
      ) : null}

      {kind === "dns" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500">Record type</span>
            <select
              value={dnsRecordType}
              onChange={(e) => setDnsRecordType(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            >
              {DNS_RECORD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs text-slate-500">Expected value contains (optional)</span>
            <input
              value={dnsExpectedValue}
              onChange={(e) => setDnsExpectedValue(e.target.value)}
              maxLength={255}
              placeholder="1.2.3.4"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-slate-500">Interval (seconds)</span>
          <input
            type="number"
            min={10}
            max={86_400}
            value={intervalSec}
            onChange={(e) => setIntervalSec(parseInt(e.target.value, 10) || 60)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">Failures to alert</span>
          <input
            type="number"
            min={1}
            max={20}
            value={failThreshold}
            onChange={(e) => setFailThreshold(parseInt(e.target.value, 10) || 2)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">Successes to clear</span>
          <input
            type="number"
            min={1}
            max={20}
            value={recoverThreshold}
            onChange={(e) => setRecoverThreshold(parseInt(e.target.value, 10) || 2)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      </div>

      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900"
        />
        <span>Enabled</span>
      </label>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> {initial ? "Save changes" : "Create monitor"}
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
      </div>
    </form>
  );
}
