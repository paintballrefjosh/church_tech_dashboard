"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Save } from "lucide-react";
import { DNS_RECORD_TYPES, type Monitor } from "@church/shared";
import { RunbookField } from "@/components/runbook-link";

type Kind = "http" | "tcp" | "icmp" | "tls" | "dns" | "hls" | "hyperdeck" | "pjlink" | "shure" | "obs";

const AV_KINDS: Kind[] = ["hls", "hyperdeck", "pjlink", "shure", "obs"];

type Rec = Record<string, unknown>;
const optStr = (o: Rec, k: string, d = ""): string => (typeof o[k] === "string" ? (o[k] as string) : d);
const optNum = (o: Rec, k: string, d: number): number => (typeof o[k] === "number" ? (o[k] as number) : d);
const optBool = (o: Rec, k: string): boolean => o[k] === true;

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
  const [showOnStatus, setShowOnStatus] = useState(initial?.showOnStatus ?? false);
  const [statusName, setStatusName] = useState(initial?.statusName ?? "");
  const [runbookPageId, setRunbookPageId] = useState<string | null>(initial?.runbookPageId ?? null);
  // Per-kind options (only the ones relevant to the selected kind are submitted).
  const [httpMethod, setHttpMethod] = useState(optStr(o, "method", "GET"));
  const [httpExpectedStatus, setHttpExpectedStatus] = useState(optNum(o, "expectedStatus", 200));
  const [httpExpectBody, setHttpExpectBody] = useState(optStr(o, "expectBody"));
  const [tlsPort, setTlsPort] = useState(optNum(o, "port", 443));
  const [tlsWarnDays, setTlsWarnDays] = useState(optNum(o, "warnDays", 21));
  const [dnsRecordType, setDnsRecordType] = useState(optStr(o, "recordType", "A"));
  const [dnsExpectedValue, setDnsExpectedValue] = useState(optStr(o, "expectedValue"));
  // AV kinds. A saved password comes back as "[saved]" and is sent back as it is, which keeps it.
  const [password, setPassword] = useState(optStr(o, "password"));
  const [hlsMaxAge, setHlsMaxAge] = useState(optNum(o, "maxAgeSec", 60));
  const [expectRecording, setExpectRecording] = useState(optBool(o, "expectRecording"));
  const [expectStreaming, setExpectStreaming] = useState(optBool(o, "expectStreaming"));
  const [minRecordMinutes, setMinRecordMinutes] = useState(optNum(o, "minRecordMinutes", 0));
  const [expectOn, setExpectOn] = useState(optBool(o, "expectOn"));
  const [maxLampHours, setMaxLampHours] = useState(optNum(o, "maxLampHours", 0));
  const [shureChannels, setShureChannels] = useState(optNum(o, "channels", 4));
  const [shureMinBars, setShureMinBars] = useState(optNum(o, "minBars", 1));
  const [schedule, setSchedule] = useState(optStr(o, "schedule"));
  const [alerts, setAlerts] = useState(o.alerts !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function buildOptions(): Rec {
    const opts = kindOptions();
    if (schedule.trim()) opts.schedule = schedule.trim();
    if (!alerts) opts.alerts = false;
    return opts;
  }

  function kindOptions(): Rec {
    switch (kind) {
      case "hls":
        return { maxAgeSec: hlsMaxAge };
      case "hyperdeck":
        return { expectRecording, ...(minRecordMinutes > 0 ? { minRecordMinutes } : {}) };
      case "pjlink":
        return { expectOn, ...(maxLampHours > 0 ? { maxLampHours } : {}), ...(password ? { password } : {}) };
      case "shure":
        return { channels: shureChannels, minBars: shureMinBars };
      case "obs":
        return { expectStreaming, expectRecording, ...(password ? { password } : {}) };
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
        showOnStatus,
        statusName: statusName.trim() || null,
        runbookPageId,
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
        <span className="text-xs text-slate-500 dark:text-slate-400">Name</span>
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
          <span className="text-xs text-slate-500 dark:text-slate-400">Kind</span>
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
            <optgroup label="AV and livestream">
              <option value="hls">Livestream (HLS playlist)</option>
              <option value="hyperdeck">Blackmagic HyperDeck</option>
              <option value="pjlink">Projector or display (PJLink)</option>
              <option value="shure">Shure wireless receiver</option>
              <option value="obs">OBS Studio</option>
            </optgroup>
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">Target</span>
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
                : kind === "hls"
                ? "https://stream.example.com/live/playlist.m3u8"
                : AV_KINDS.includes(kind)
                ? "192.168.20.30 (or host:port)"
                : "host.example.com"
            }
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      </div>

      {kind === "http" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-slate-500 dark:text-slate-400">Method</span>
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
            <span className="text-xs text-slate-500 dark:text-slate-400">Expected status</span>
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
            <span className="text-xs text-slate-500 dark:text-slate-400">Body contains (optional)</span>
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
            <span className="text-xs text-slate-500 dark:text-slate-400">Port</span>
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
            <span className="text-xs text-slate-500 dark:text-slate-400">Warn when days left ≤</span>
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
            <span className="text-xs text-slate-500 dark:text-slate-400">Record type</span>
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
            <span className="text-xs text-slate-500 dark:text-slate-400">Expected value contains (optional)</span>
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

      {AV_KINDS.includes(kind) ? (
        <fieldset className="space-y-3 rounded-md border border-slate-300 p-3 dark:border-slate-700">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">What counts as working</legend>
          {kind === "hls" ? (
            <label className="block max-w-xs">
              <span className="text-xs text-slate-500 dark:text-slate-400">Newest segment no older than (seconds)</span>
              <input type="number" min={10} max={3600} value={hlsMaxAge} onChange={(e) => setHlsMaxAge(parseInt(e.target.value, 10) || 60)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
            </label>
          ) : null}
          {kind === "hyperdeck" || kind === "obs" ? (
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={expectRecording} onChange={(e) => setExpectRecording(e.target.checked)} />
              <span>Down unless it is recording</span>
            </label>
          ) : null}
          {kind === "obs" ? (
            <label className="inline-flex items-center gap-2 sm:ml-4">
              <input type="checkbox" checked={expectStreaming} onChange={(e) => setExpectStreaming(e.target.checked)} />
              <span>Down unless it is streaming</span>
            </label>
          ) : null}
          {kind === "hyperdeck" ? (
            <label className="block max-w-xs">
              <span className="text-xs text-slate-500 dark:text-slate-400">Recording space at least (minutes, 0 = do not check)</span>
              <input type="number" min={0} max={6000} value={minRecordMinutes} onChange={(e) => setMinRecordMinutes(parseInt(e.target.value, 10) || 0)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
            </label>
          ) : null}
          {kind === "pjlink" ? (
            <>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={expectOn} onChange={(e) => setExpectOn(e.target.checked)} />
                <span>Down unless it is switched on</span>
              </label>
              <label className="block max-w-xs">
                <span className="text-xs text-slate-500 dark:text-slate-400">Lamp hours at most (0 = do not check)</span>
                <input type="number" min={0} max={100000} value={maxLampHours} onChange={(e) => setMaxLampHours(parseInt(e.target.value, 10) || 0)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
              </label>
            </>
          ) : null}
          {kind === "shure" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-slate-500 dark:text-slate-400">Channels on the receiver</span>
                <input type="number" min={1} max={8} value={shureChannels} onChange={(e) => setShureChannels(parseInt(e.target.value, 10) || 4)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500 dark:text-slate-400">Problem at this many battery bars or fewer (of 5)</span>
                <input type="number" min={0} max={4} value={shureMinBars} onChange={(e) => setShureMinBars(parseInt(e.target.value, 10) || 0)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
              </label>
            </div>
          ) : null}
          {kind === "pjlink" || kind === "obs" ? (
            <label className="block max-w-sm">
              <span className="text-xs text-slate-500 dark:text-slate-400">{kind === "obs" ? "OBS WebSocket password" : "PJLink password"} (blank if none)</span>
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">Kept for the checks and never shown again, not even to admins.</span>
            </label>
          ) : null}
        </fieldset>
      ) : null}

      <label className="block">
        <span className="text-xs text-slate-500 dark:text-slate-400">Only check during these hours (optional)</span>
        <textarea
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Sun 08:00-13:00; Wed 18:30-20:30"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950 font-mono text-xs"
        />
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          On the site&apos;s clock. Outside these hours it is not checked and counts as fine, so a stream or projector that is meant to be
          off does not page anyone. Blank = always.
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Interval (seconds)</span>
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
          <span className="text-xs text-slate-500 dark:text-slate-400">Failures to alert</span>
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
          <span className="text-xs text-slate-500 dark:text-slate-400">Successes to clear</span>
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
          className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900"
        />
        <span>Enabled</span>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={alerts}
          onChange={(e) => setAlerts(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900"
        />
        <span>
          Send alerts
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            Tell people when it goes down and comes back. Off: its incidents are still recorded and shown, but nobody is notified.
          </span>
        </span>
      </label>

      <fieldset className="space-y-2 rounded-md border border-slate-300 p-3 dark:border-slate-700">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Status page</legend>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showOnStatus}
            onChange={(e) => setShowOnStatus(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900"
          />
          <span>Show on the status page (everyone who signs in can see it)</span>
        </label>
        {showOnStatus ? (
          <label className="block">
            <span className="text-sm">Name on the status page</span>
            <input
              value={statusName}
              onChange={(e) => setStatusName(e.target.value)}
              maxLength={120}
              placeholder={name || "For example: Internet"}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">Plain words for staff and volunteers. Leave blank to use the monitor's name. The address being checked is never shown.</span>
          </label>
        ) : null}
      </fieldset>

      <RunbookField value={runbookPageId} onChange={setRunbookPageId} />

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
