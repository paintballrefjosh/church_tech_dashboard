"use client";

import { useState } from "react";
import { CISCO_ALERT_CATEGORIES, type CiscoAlertPrefs, type CiscoSwitch } from "@church/shared";
import { Modal, Field, inputCls } from "./cisco-ui";
import { choiceToDevice, choiceToInput, currentChoice, resolveSwitchView, switchViewSentence } from "@/lib/faceplates/custom";
import { errorText, useSwitchModels } from "@/lib/use-switch-models";

export const NO_ALERTS: CiscoAlertPrefs = {
  deviceOffline: false,
  portStateChange: false,
  configChange: false,
  uptimeChange: false,
};

export interface SwitchFormState {
  id: string | null;
  hostname: string;
  ipAddress: string;
  username: string;
  password: string;
  model: string;
  location: string;
  checkPortState: boolean;
  checkPortChannels: boolean;
  alertPrefs: CiscoAlertPrefs;
  /** The switch view choice: "auto", "off" or "model:<id>" (only an existing switch has one). */
  viewChoice: string;
}

export const EMPTY_SWITCH_FORM: SwitchFormState = {
  id: null,
  hostname: "",
  ipAddress: "",
  username: "admin",
  password: "",
  model: "",
  location: "",
  checkPortState: true,
  checkPortChannels: false,
  alertPrefs: { ...NO_ALERTS },
  viewChoice: "auto",
};

/** The form for an existing switch. `viewChoice` is "auto" until the models are known (the form reads them itself). */
export function formFromSwitch(s: CiscoSwitch): SwitchFormState {
  return {
    id: s.id,
    hostname: s.hostname,
    ipAddress: s.ipAddress,
    username: s.username,
    password: "",
    model: s.model ?? "",
    location: s.location ?? "",
    checkPortState: s.checkPortState,
    checkPortChannels: s.checkPortChannels ?? false,
    alertPrefs: { ...NO_ALERTS, ...s.alertPrefs },
    viewChoice: s.switchViewOff ? "off" : s.switchModelId ? `model:${s.switchModelId}` : "auto",
  };
}

/**
 * Add or edit a switch. Used by the switches list and by a switch's own page. Editing also holds the switch view: which
 * device profile draws this switch (matched on the model text, a model picked for this switch, or none), with what the
 * current model text would match shown as you type.
 */
export function SwitchFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: SwitchFormState;
  onClose: () => void;
  /** Called after a successful save with a sentence for the status line; the parent reloads and the form closes. */
  onSaved: (text: string) => void | Promise<void>;
}) {
  const [form, setForm] = useState<SwitchFormState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { models } = useSwitchModels();
  const editing = form.id !== null;

  // A pick of a model that is gone reads as automatic, as the switch page does.
  const choice = models ? currentChoice(models, choiceToDevice(form.viewChoice)) : form.viewChoice;
  const preview =
    models && editing
      ? switchViewSentence(resolveSwitchView(models, { model: form.model.trim() || null, ...choiceToDevice(choice) }), form.model.trim() || null)
      : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        hostname: form.hostname.trim(),
        ipAddress: form.ipAddress.trim(),
        username: form.username.trim(),
        model: form.model.trim() || undefined,
        location: form.location.trim() || undefined,
        checkPortState: form.checkPortState,
        checkPortChannels: form.checkPortChannels,
        alertPrefs: form.alertPrefs,
      };
      if (form.password) body.password = form.password;
      const r = await fetch(editing ? `/api/cisco/switches/${form.id}` : "/api/cisco/switches", {
        method: editing ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      // The picture choice has its own route (it changes nothing on the switch); only sent when it changed.
      if (editing && models && choice !== initial.viewChoice) {
        const v = await fetch(`/api/cisco/switches/${form.id}/switch-view`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(choiceToInput(choice)),
        });
        if (!v.ok) {
          setError(`The switch was saved, but its switch view was not: ${await errorText(v)}`);
          return;
        }
      }
      await onSaved(editing ? "Switch saved." : "Switch added — polling + importing ports in the background.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? "Edit switch" : "Add switch"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3 text-sm">
        {!editing ? (
          <p className="rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
            The switch is polled immediately on save and all interfaces imported as the baseline config.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hostname *">
            <input required value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} className={`w-full ${inputCls}`} />
          </Field>
          <Field label="IP address *">
            <input required value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} className={`w-full font-mono text-xs ${inputCls}`} />
          </Field>
          <Field label="Username">
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={`w-full font-mono text-xs ${inputCls}`} />
          </Field>
          <Field label={editing ? "Password (leave blank to keep)" : "Password"}>
            <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={`w-full ${inputCls}`} />
          </Field>
          <Field label="Model (auto-detected)">
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="auto-detected" className={`w-full ${inputCls}`} />
          </Field>
          <Field label="Location">
            <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={`w-full ${inputCls}`} />
          </Field>
        </div>

        {editing && models ? (
          <div className="space-y-1">
            <Field label="Switch view (the picture of this switch)">
              <select
                value={choice}
                onChange={(e) => setForm({ ...form, viewChoice: e.target.value })}
                className={`w-full ${inputCls}`}
              >
                <option value="auto">Automatic (match the model text)</option>
                {models.filter((m) => m.kind !== "module").map((m) => (
                  <option key={m.id} value={`model:${m.id}`}>
                    Use {m.name}
                  </option>
                ))}
                <option value="off">No switch view (list only)</option>
              </select>
            </Field>
            {preview ? <p className="text-[11px] text-slate-500 dark:text-slate-400">{preview}</p> : null}
          </div>
        ) : null}

        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={form.checkPortState} onChange={(e) => setForm({ ...form, checkPortState: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700" />
          <span>Port state monitoring</span>
        </label>
        <label className={`ml-6 flex items-start gap-2 ${form.checkPortState ? "" : "opacity-50"}`}>
          <input
            type="checkbox"
            checked={form.checkPortChannels}
            disabled={!form.checkPortState}
            onChange={(e) => setForm({ ...form, checkPortChannels: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 disabled:cursor-not-allowed dark:border-slate-700"
          />
          <span>
            Include port-channels
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Off: a port-channel is a logical bundle, so it is neither counted as a port down nor alerted on. Its member ports still are.
            </span>
          </span>
        </label>

        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Alerts</legend>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Notify monitoring admins (in-app + email) when this switch changes state.
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {CISCO_ALERT_CATEGORIES.map((c) => {
              // Port-state-change alerts only fire when port-state monitoring
              // is on (see cisco.poller evaluateAlerts), so grey the toggle out
              // when the master switch is off to reflect that it has no effect.
              const disabled = c.key === "portStateChange" && !form.checkPortState;
              return (
                <label key={c.key} className={`flex items-start gap-2 ${disabled ? "opacity-50" : ""}`}>
                  <input
                    type="checkbox"
                    checked={form.alertPrefs[c.key]}
                    disabled={disabled}
                    onChange={(e) => setForm({ ...form, alertPrefs: { ...form.alertPrefs, [c.key]: e.target.checked } })}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 disabled:cursor-not-allowed dark:border-slate-700"
                  />
                  <span>
                    <span className="block text-sm">{c.label}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                      {disabled ? "Requires port state monitoring (above)." : c.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {error ? (
          <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {editing ? "Save changes" : "Add & import"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
