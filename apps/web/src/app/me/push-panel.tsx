"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Send, Smartphone, Trash2 } from "lucide-react";
import { endpointFingerprint, pushBlocker, serviceWorkerReady, urlBase64ToUint8Array, type PushBlocker } from "@/lib/push";

interface Device {
  id: string;
  fingerprint: string;
  label: string;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

interface Status {
  enabled: boolean;
  publicKey: string | null;
  devices: Device[];
}

const BLOCKED_TEXT: Record<PushBlocker, string> = {
  insecure: "Push needs the site to be opened over HTTPS. Open it at its https address and come back here.",
  unsupported: "This browser cannot receive push notifications. On an iPhone or iPad, add the site to the Home Screen first, then open it from there.",
  denied: "Notifications are blocked for this site in your browser settings. Allow them there, then reload this page.",
};

/**
 * Browser push: turn it on or off for THIS browser, see every browser that is on, and send a test. Which kinds push is chosen
 * in the table below (the Push column). The subscription lives in the browser; the server only keeps its address and keys.
 */
export function PushPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<PushBlocker | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    let next: Status | null = null;
    try {
      const r = await fetch("/api/v1/me/push", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) next = (await r.json()) as Status;
    } catch {
      /* shown below as unavailable */
    }
    setStatus(next);
    // The preferences table below offers its Push column only while some browser has push on.
    window.dispatchEvent(new CustomEvent("push:devices", { detail: next?.devices.length ?? 0 }));
    const b = pushBlocker();
    setBlocker(b);
    if (b === "insecure" || b === "unsupported") {
      setHere(null);
      return;
    }
    try {
      const reg = await serviceWorkerReady();
      const sub = await reg.pushManager.getSubscription();
      setHere(sub ? await endpointFingerprint(sub.endpoint) : null);
    } catch {
      setHere(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function turnOn() {
    if (!status?.publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMsg({ tone: "err", text: BLOCKED_TEXT.denied });
        return;
      }
      const reg = await serviceWorkerReady();
      const key = urlBase64ToUint8Array(status.publicKey);
      let sub = await reg.pushManager.getSubscription();
      // A subscription made for a different site key (after the secret changed) cannot be reused.
      if (sub) await sub.unsubscribe().catch(() => undefined);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const r = await fetch("/api/v1/me/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (!r.ok) {
        await sub.unsubscribe().catch(() => undefined);
        setMsg({ tone: "err", text: "The server did not accept this browser's push address." });
        return;
      }
      setMsg({ tone: "ok", text: "Now pick which notices push, in the table below." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "err", text: `Could not turn push on: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(d: Device) {
    setBusy(true);
    setMsg(null);
    try {
      if (d.fingerprint === here) {
        const reg = await serviceWorkerReady();
        const sub = await reg.pushManager.getSubscription();
        await sub?.unsubscribe().catch(() => undefined);
      }
      await fetch(`/api/v1/me/push/subscriptions/${d.id}`, { method: "DELETE", credentials: "same-origin" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/v1/me/push/test", { method: "POST", credentials: "same-origin" });
      if (!r.ok) {
        setMsg({ tone: "err", text: "The test could not be sent." });
        return;
      }
      const out = (await r.json()) as { sent: number; failed: number; removed: number };
      setMsg(
        out.sent > 0
          ? { tone: "ok", text: `Sent to ${out.sent} ${out.sent === 1 ? "device" : "devices"}.${out.failed ? ` ${out.failed} failed.` : ""}` }
          : { tone: "err", text: out.removed ? "That device was no longer registered and has been removed." : "Nothing was delivered. See the device list for the reason." },
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading...</p>;
  if (!status.enabled) {
    return <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="push-off">Push notifications are switched off for this site.</p>;
  }

  const btn =
    "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900";

  return (
    <div className="space-y-3" data-testid="push-panel">
      {blocker ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="push-blocker">
          {BLOCKED_TEXT[blocker]}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {here ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400" data-testid="push-status">
              <BellRing className="h-4 w-4" aria-hidden /> Push is on for this browser.
            </span>
          ) : (
            <button type="button" onClick={() => void turnOn()} disabled={busy} className={btn} data-testid="push-enable">
              <BellRing className="h-4 w-4" aria-hidden /> Turn on for this browser
            </button>
          )}
          {status.devices.length > 0 ? (
            <button type="button" onClick={() => void test()} disabled={busy} className={btn} data-testid="push-test">
              <Send className="h-4 w-4" aria-hidden /> Send a test
            </button>
          ) : null}
        </div>
      )}
      {msg ? (
        <p role={msg.tone === "err" ? "alert" : "status"} className={`text-sm ${msg.tone === "err" ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
          {msg.text}
        </p>
      ) : null}
      {status.devices.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 text-sm dark:divide-slate-800 dark:border-slate-800" data-testid="push-devices">
          {status.devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2" data-testid="push-device">
              <Smartphone className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {d.label}
                  {d.fingerprint === here ? <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs font-normal text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">this browser</span> : null}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Added {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastSentAt ? `, last notice ${new Date(d.lastSentAt).toLocaleString()}` : ", nothing sent yet"}
                </div>
                {d.lastError ? <div className="text-xs text-rose-600 dark:text-rose-400">Last attempt failed: {d.lastError}</div> : null}
              </div>
              <button
                type="button"
                onClick={() => void removeDevice(d)}
                disabled={busy}
                aria-label={`Remove ${d.label}`}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-950"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">No browsers have push turned on yet.</p>
      )}
    </div>
  );
}
