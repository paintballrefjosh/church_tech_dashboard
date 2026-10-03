"use client";

import { useEffect, useState } from "react";
import { Save, Bell, Mail } from "lucide-react";
import type { NotificationKind } from "@church/shared";

// Human-readable labels for the catalogue. Anything not listed here falls
// back to the raw kind id so a new kind shows up immediately even before we
// give it a label.
const KIND_LABELS: Record<string, { title: string; hint: string }> = {
  "ticket.assigned": {
    title: "Ticket assigned to you",
    hint: "When someone assigns a ticket to you.",
  },
  "ticket.status_changed": {
    title: "Ticket status changes",
    hint: "Status moves on a ticket you opened or that's assigned to you.",
  },
  "ticket.comment": {
    title: "Ticket comments",
    hint: "New comment on a ticket you own or are assigned to.",
  },
  "wiki.updated": {
    title: "Wiki page updates",
    hint: "A page you own or have access to is edited.",
  },
  "monitor.incident.opened": {
    title: "Monitoring incident opened",
    hint: "A monitored service goes down.",
  },
  "monitor.incident.resolved": {
    title: "Monitoring incident resolved",
    hint: "A previously-down service recovers.",
  },
  mention: {
    title: "Mentions",
    hint: "Someone @mentions you in a comment or note.",
  },
  "checklist.assigned": {
    title: "Checklist task assigned",
    hint: "A checklist task is assigned to you.",
  },
  "user.approval_pending": {
    title: "Account awaiting approval",
    hint: "A new external account needs an admin to approve it. (Admins only.)",
  },
  "cisco.device_offline": {
    title: "Cisco switch offline",
    hint: "A Cisco switch becomes unreachable (or recovers). Per-switch toggle in switch settings.",
  },
  "cisco.port_change": {
    title: "Cisco port state change",
    hint: "A switch port goes up or down between polls.",
  },
  "cisco.config_change": {
    title: "Cisco config change",
    hint: "A switch's running-config changed (a new backup was captured).",
  },
  "cisco.uptime_change": {
    title: "Cisco switch rebooted",
    hint: "A switch's uptime reset, indicating a reboot.",
  },
  "unifi.device_offline": {
    title: "UniFi device offline",
    hint: "A UniFi device (AP, switch, gateway) goes offline or recovers. Enable in Monitoring & Network settings.",
  },
};

interface Pref {
  /** In-app (bell + realtime) — the baseline channel for an enabled category. */
  enabled: boolean;
  /** Also deliver this category by email. */
  email: boolean;
}

interface PrefsResponse {
  muted?: string[];
  channels?: Record<string, string[]>;
}

/**
 * Map the stored channel array (or the muted flag) to the two-toggle model.
 * No row => default to in-app + email (matches the server's default).
 */
function toPref(channels: string[] | undefined, muted: boolean): Pref {
  if (muted) return { enabled: false, email: false };
  const ch = channels ?? ["in_app", "email"];
  const enabled = ch.length > 0;
  return { enabled, email: enabled && ch.includes("email") };
}

interface Props {
  kinds: readonly NotificationKind[];
}

export function NotificationPrefsForm({ kinds }: Props) {
  const [prefs, setPrefs] = useState<Record<string, Pref>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Load current prefs (channels + legacy muted) and fold them into the
  // enabled/email model. Done client-side so the parent page doesn't have to
  // thread channel data through.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let data: PrefsResponse = {};
      try {
        const r = await fetch("/api/me/notification-prefs", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (r.ok) data = (await r.json()) as PrefsResponse;
      } catch {
        /* fall through to defaults */
      }
      if (cancelled) return;
      const mutedSet = new Set(data.muted ?? []);
      const next: Record<string, Pref> = {};
      for (const k of kinds) next[k] = toPref(data.channels?.[k], mutedSet.has(k));
      setPrefs(next);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [kinds]);

  function setEnabled(kind: string, value: boolean) {
    setPrefs((prev) => ({
      ...prev,
      // Turning a category off also drops email; turning it on keeps whatever
      // email choice was there.
      [kind]: { enabled: value, email: value ? (prev[kind]?.email ?? false) : false },
    }));
    setOk(null);
  }

  function setEmail(kind: string, value: boolean) {
    setPrefs((prev) => ({
      ...prev,
      [kind]: { enabled: prev[kind]?.enabled ?? true, email: value },
    }));
    setOk(null);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      // channels is the source of truth: in-app is implied for every enabled
      // category, email is opt-in. We also clear the legacy muted list so it
      // can never override these channel choices.
      const channels: Record<string, string[]> = {};
      for (const k of kinds) {
        const p = prefs[k] ?? { enabled: true, email: true };
        channels[k] = p.enabled ? (p.email ? ["in_app", "email"] : ["in_app"]) : [];
      }
      const r = await fetch("/api/me/notification-prefs", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channels, muted: [] }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        const msg = Array.isArray(body.message) ? body.message.join(", ") : body.message;
        setErr(msg ?? `Request failed (${r.status})`);
        return;
      }
      setOk("Preferences saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Loading preferences…</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
        {kinds.map((kind) => {
          const pref = prefs[kind] ?? { enabled: true, email: true };
          const meta = KIND_LABELS[kind] ?? { title: kind, hint: "" };
          return (
            <li key={kind} className="flex flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Bell
                  className={`mt-0.5 h-4 w-4 shrink-0 ${pref.enabled ? "text-brand-600" : "text-slate-400"}`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{meta.title}</div>
                  {meta.hint ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400">{meta.hint}</div>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={pref.enabled}
                    onChange={(e) => setEnabled(kind, e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900"
                  />
                  <span>In-app</span>
                </label>
                <label
                  className={`inline-flex items-center gap-2 text-xs ${
                    pref.enabled
                      ? "cursor-pointer text-slate-600 dark:text-slate-300"
                      : "cursor-not-allowed text-slate-400 dark:text-slate-600"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={pref.email}
                    disabled={!pref.enabled}
                    onChange={(e) => setEmail(kind, e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                  />
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                  <span>Email</span>
                </label>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> Save preferences
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
        {ok ? <span className="text-emerald-600 dark:text-emerald-400">{ok}</span> : null}
      </div>
    </div>
  );
}
