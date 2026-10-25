"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { SwitchModel } from "@church/shared";
import { Modal } from "../network-cisco/cisco-ui";
import { choiceToDevice, choiceToInput, currentChoice, resolveSwitchView } from "@/lib/faceplates/custom";
import { pickableProfiles, ProfilePictures } from "@/components/device-picture";
import { errorText } from "@/lib/use-switch-models";

export interface PictureDevice {
  mac: string;
  name: string;
  model: string | null;
  switchModelId?: string | null;
  switchViewOff?: boolean;
}

/**
 * Choose which device profile draws a UniFi device (in cabinets and on its printed port sheet): automatic (matched on the
 * model text the controller reports), a profile, or none. Nothing is sent to the controller.
 */
export function UnifiPictureDialog({
  device,
  models,
  onClose,
  onSaved,
}: {
  device: PictureDevice;
  models: SwitchModel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState(() => currentChoice(models, device));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = pickableProfiles(models);
  const preview = resolveSwitchView(models, { model: device.model, ...choiceToDevice(choice) });
  const matched = resolveSwitchView(models, { model: device.model });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/unifi/devices/${encodeURIComponent(device.mac)}/switch-view`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(choiceToInput(choice)),
      });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      onSaved();
    } catch {
      setError("The choice could not be saved (network error).");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Picture of ${device.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>
          <label htmlFor={id} className="text-xs text-slate-500 dark:text-slate-400">
            Device profile
          </label>
          <select
            id={id}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="auto">
              Automatic ({matched.model ? `${matched.model.name}, matched on "${matched.matched}"` : device.model ? `nothing matches ${device.model}` : "no model reported"})
            </option>
            {list.map((m) => (
              <option key={m.id} value={`model:${m.id}`}>
                {m.name}
              </option>
            ))}
            <option value="off">No picture</option>
          </select>
        </div>
        {preview.model ? (
          <ProfilePictures model={preview.model} deviceName={device.name} />
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Shown as a plain drawing in cabinets, and without a picture on its port sheet.
          </p>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Profiles are made on the{" "}
          <Link href="/device-profiles" className="text-brand-600 underline dark:text-brand-400">
            Device profiles
          </Link>{" "}
          page. A profile picked for a cabinet item still wins there.
        </p>
        {error ? (
          <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
