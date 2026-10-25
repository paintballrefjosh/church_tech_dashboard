"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Pencil, Plus, Send, Trash2 } from "lucide-react";
import {
  ALERT_CHANNEL_SECRET,
  ALERT_CHANNEL_TYPES,
  ALERT_CHANNEL_TYPE_LABELS,
  type AlertChannel,
  type AlertChannelEvents,
  type AlertChannelType,
} from "@church/shared";
import { useCanWrite, inputCls, cardCls, fmtTime, Modal, Field, useToasts, ToastStack } from "../network-cisco/cisco-ui";

const EVENTS_LABEL: Record<AlertChannelEvents, string> = {
  outages: "Outages: down, back up, escalated, unstable",
  everything: "Everything: outages, switch config changes and reboots",
};

/** The fields each type asks for, beyond name, events and the secret. Values are kept as strings in the form. */
const FIELDS: Record<AlertChannelType, Array<{ key: string; label: string; placeholder?: string; list?: boolean }>> = {
  ntfy: [
    { key: "server", label: "Server", placeholder: "https://ntfy.sh" },
    { key: "topic", label: "Topic", placeholder: "church-it-alerts" },
  ],
  pushover: [{ key: "userKey", label: "User or group key" }],
  slack: [],
  teams: [],
  discord: [],
  webhook: [{ key: "url", label: "Address the alert is posted to", placeholder: "https://automation.example.org/hook" }],
  twilio: [
    { key: "accountSid", label: "Account SID", placeholder: "AC..." },
    { key: "from", label: "From number", placeholder: "+441234567890" },
    { key: "to", label: "To numbers (one per line)", placeholder: "+447700900000", list: true },
  ],
};

const HELP: Record<AlertChannelType, string> = {
  ntfy: "Install the ntfy app and subscribe to the topic. On ntfy.sh anyone who knows the topic can read it, so pick one that is hard to guess, or use your own server with an access token.",
  pushover: "Create an application at pushover.net for its API token; the user key is on your Pushover dashboard (a group key reaches a whole team).",
  slack: "In Slack, add an Incoming Webhook to the channel and paste its address (https://hooks.slack.com/...).",
  teams: "In Teams, add the Workflows template \"Post to a channel when a webhook request is received\" and paste the address it gives.",
  discord: "In the Discord channel's settings, Integrations > Webhooks > New Webhook, then copy its address.",
  webhook: "The alert is POSTed as JSON (kind, severity, title, body, url, site, at). With a signing secret, X-Church-Signature is sha256=HMAC(secret, timestamp + \".\" + body) and X-Church-Timestamp the timestamp.",
  twilio: "Text messages cost money per message: use Outages, not Everything. The auth token is on the Twilio console next to the Account SID.",
};

interface FormState {
  id: string | null;
  name: string;
  type: AlertChannelType;
  events: AlertChannelEvents;
  enabled: boolean;
  config: Record<string, string>;
  secret: string;
  hasSecret: boolean;
}

const EMPTY: FormState = { id: null, name: "", type: "ntfy", events: "outages", enabled: true, config: {}, secret: "", hasSecret: false };

function toForm(c: AlertChannel): FormState {
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.config)) config[k] = Array.isArray(v) ? v.join("\n") : String(v ?? "");
  return { id: c.id, name: c.name, type: c.type, events: c.events, enabled: c.enabled, config, secret: "", hasSecret: c.hasSecret };
}

function configOf(f: FormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS[f.type]) {
    const raw = (f.config[field.key] ?? "").trim();
    if (field.list) out[field.key] = raw.split(/\s*\n\s*|\s*,\s*/).filter(Boolean);
    else if (raw) out[field.key] = raw;
  }
  return out;
}

/** The first readable message out of an API error body (Zod's flatten, or Nest's message). */
function errorText(body: unknown, status: number): string {
  const b = body as { message?: unknown; fieldErrors?: Record<string, string[]>; formErrors?: string[] } | null;
  if (b?.message) {
    const m = b.message as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | string;
    if (typeof m === "string") return m;
    const first = Object.values(m.fieldErrors ?? {})[0]?.[0] ?? m.formErrors?.[0];
    if (first) return first;
  }
  return `Failed (${status})`;
}

export default function AlertChannelsPage() {
  const canWrite = useCanWrite();
  const [channels, setChannels] = useState<AlertChannel[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const { toasts, show: push, dismiss } = useToasts();

  const load = useCallback(async () => {
    const r = await fetch("/api/alert-channels", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) {
      setForbidden(true);
      return;
    }
    if (r.ok) setChannels((await r.json()) as AlertChannel[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(path: string, method: string, body?: unknown): Promise<AlertChannel | null> {
    const r = await fetch(`/api/alert-channels${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await r.json().catch(() => null)) as unknown;
    if (!r.ok) throw new Error(errorText(data, r.status));
    return data as AlertChannel | null;
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: form.name, events: form.events, enabled: form.enabled, config: configOf(form) };
      if (form.secret.trim() || !form.id) body.secret = form.secret;
      if (form.id) await call(`/${form.id}`, "PATCH", body);
      else await call("", "POST", { ...body, type: form.type });
      push(true, form.id ? "Saved." : "Channel added. Send a test to check it.");
      setForm(null);
      await load();
    } catch (err) {
      push(false, (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test(c: AlertChannel) {
    try {
      await call(`/${c.id}/test`, "POST");
      push(true, `Test sent to ${c.name}.`);
    } catch (err) {
      push(false, `${c.name}: ${(err as Error).message}`);
    }
    await load();
  }

  async function toggle(c: AlertChannel) {
    try {
      await call(`/${c.id}`, "PATCH", { enabled: !c.enabled });
      await load();
    } catch (err) {
      push(false, (err as Error).message);
    }
  }

  async function remove(c: AlertChannel) {
    if (!confirm(`Remove the alert channel "${c.name}"? Alerts stop going there.`)) return;
    try {
      await call(`/${c.id}`, "DELETE");
      await load();
    } catch (err) {
      push(false, (err as Error).message);
    }
  }

  if (forbidden) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Alert channels are set up by people with the Monitoring admin tier. Ask one of them to add your team&apos;s chat or phone app here.
      </p>
    );
  }
  if (!channels) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <BellRing className="h-5 w-5" aria-hidden /> Alert channels
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Monitoring alerts also go to these places: a team chat, a phone app, text messages or your own automation. Each person&apos;s
            bell, email and push choices are separate, under their notification settings. Maintenance mode pauses these too.
          </p>
        </div>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setForm({ ...EMPTY })}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add a channel
          </button>
        ) : null}
      </div>

      {channels.length === 0 ? (
        <p className={`${cardCls} text-sm text-slate-600 dark:text-slate-400`}>No channels yet. Alerts go only to people&apos;s bell, email and push.</p>
      ) : (
        <ul className="space-y-2">
          {channels.map((c) => (
            <li key={c.id} className={`${cardCls} flex flex-wrap items-center gap-3`}>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {c.name}{" "}
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    {ALERT_CHANNEL_TYPE_LABELS[c.type]} · {c.events === "outages" ? "Outages" : "Everything"}
                    {c.enabled ? "" : " · Switched off"}
                  </span>
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Last sent: {fmtTime(c.lastSentAt)}
                  {c.lastError ? (
                    <span className="ml-2 text-rose-700 dark:text-rose-300">
                      Last failure {fmtTime(c.lastErrorAt)}: {c.lastError}
                    </span>
                  ) : null}
                </p>
              </div>
              {canWrite ? (
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={c.enabled} onChange={() => void toggle(c)} />
                    On
                  </label>
                  <button type="button" onClick={() => void test(c)} className="inline-flex min-h-[24px] items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700" aria-label={`Send a test to ${c.name}`}>
                    <Send className="h-4 w-4" aria-hidden /> Test
                  </button>
                  <button type="button" onClick={() => setForm(toForm(c))} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Edit ${c.name}`}>
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" onClick={() => void remove(c)} className="rounded-md p-1.5 text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950" aria-label={`Remove ${c.name}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <Modal title={form.id ? `Edit ${form.name}` : "Add an alert channel"} onClose={() => setForm(null)}>
          <div className="space-y-3">
            <Field label="Name">
              <input className={`${inputCls} w-full`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} />
            </Field>
            <Field label="Kind">
              <select
                className={`${inputCls} w-full`}
                value={form.type}
                disabled={!!form.id}
                onChange={(e) => setForm({ ...form, type: e.target.value as AlertChannelType, config: {} })}
              >
                {ALERT_CHANNEL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ALERT_CHANNEL_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-slate-600 dark:text-slate-400">{HELP[form.type]}</p>
            {FIELDS[form.type].map((f) => (
              <Field key={f.key} label={f.label}>
                {f.list ? (
                  <textarea
                    className={`${inputCls} w-full`}
                    rows={3}
                    placeholder={f.placeholder}
                    value={form.config[f.key] ?? ""}
                    onChange={(e) => setForm({ ...form, config: { ...form.config, [f.key]: e.target.value } })}
                  />
                ) : (
                  <input
                    className={`${inputCls} w-full`}
                    placeholder={f.placeholder}
                    value={form.config[f.key] ?? ""}
                    onChange={(e) => setForm({ ...form, config: { ...form.config, [f.key]: e.target.value } })}
                  />
                )}
              </Field>
            ))}
            <Field label={`${ALERT_CHANNEL_SECRET[form.type].label}${form.hasSecret ? " (saved; leave empty to keep it)" : ""}`}>
              <input
                type="password"
                autoComplete="off"
                className={`${inputCls} w-full`}
                value={form.secret}
                onChange={(e) => setForm({ ...form, secret: e.target.value })}
              />
            </Field>
            <Field label="Send">
              <select className={`${inputCls} w-full`} value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value as AlertChannelEvents })}>
                {(Object.keys(EVENTS_LABEL) as AlertChannelEvents[]).map((k) => (
                  <option key={k} value={k}>
                    {EVENTS_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Switched on
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setForm(null)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !form.name.trim()}
                onClick={() => void save()}
                className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
