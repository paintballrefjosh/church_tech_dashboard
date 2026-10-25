"use client";

import Link from "next/link";
import { useId } from "react";
import { Images } from "lucide-react";
import type { SwitchModel } from "@church/shared";
import { modelPicture } from "@/lib/rack-pictures";
import { useSwitchModels } from "@/lib/use-switch-models";

/** The profiles a device may be drawn with: whole devices, never add-on modules, by name. */
export function pickableProfiles(models: readonly SwitchModel[] | null): SwitchModel[] {
  return (models ?? []).filter((m) => m.kind !== "module").sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The picture choice on the infra host form: a device profile, or none. A host reports no model text, so there is no
 * "automatic" here (a UniFi device or a Cisco switch has one).
 */
export function DevicePictureField({ models, value, onChange }: { models: SwitchModel[] | null; value: string | null; onChange: (id: string | null) => void }) {
  const id = useId();
  const list = pickableProfiles(models);
  // A choice whose profile was deleted reads as none (the database clears it too).
  const current = value && list.some((m) => m.id === value) ? value : "";
  return (
    <fieldset className="space-y-2 rounded-md border border-slate-300 p-3 dark:border-slate-700">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Picture</legend>
      <p id={`${id}-help`} className="text-xs text-slate-500 dark:text-slate-400">
        The device profile whose front and back pictures show this host on its page and in cabinets. Profiles are made on the{" "}
        <Link href="/device-profiles" className="text-brand-600 underline dark:text-brand-400">
          Device profiles
        </Link>{" "}
        page.
      </p>
      <label htmlFor={id} className="sr-only">
        Device profile
      </label>
      <select
        id={id}
        aria-describedby={`${id}-help`}
        value={current}
        disabled={models === null}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <option value="">{models === null ? "Loading…" : "None"}</option>
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

/** The front and back pictures of a profile side by side (a side with no picture says so). */
export function ProfilePictures({ model, deviceName }: { model: SwitchModel; deviceName: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["front", "rear"] as const).map((side) => {
        const pic = modelPicture(model, side);
        const label = side === "front" ? "Front" : "Back";
        return (
          <figure key={side} className="space-y-1">
            {pic ? (
              // eslint-disable-next-line @next/next/no-img-element -- the admin's own picture, served by the API
              <img
                src={pic.url}
                width={pic.width}
                height={pic.height}
                alt={`${deviceName}, ${label.toLowerCase()} (${model.name})`}
                className="h-auto max-h-40 w-full rounded border border-slate-200 bg-slate-100 object-contain dark:border-slate-800 dark:bg-slate-900"
              />
            ) : (
              <p className="rounded border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {model.name} has no {label.toLowerCase()} picture.
              </p>
            )}
            <figcaption className="text-xs text-slate-500 dark:text-slate-400">{label}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/** The pictures of the profile chosen for a device, as a card on its page; nothing when none is chosen (or it was deleted). */
export function DevicePictureCard({ modelId, deviceName }: { modelId: string | null | undefined; deviceName: string }) {
  const { models } = useSwitchModels();
  const model = modelId ? pickableProfiles(models).find((m) => m.id === modelId) : undefined;
  if (!model) return null;
  return (
    <section aria-label="Picture" className="space-y-2 rounded-md border border-slate-300 p-3 text-sm dark:border-slate-800">
      <p className="flex items-center gap-2 font-medium">
        <Images className="h-4 w-4" aria-hidden /> Picture
        <Link href={`/device-profiles/${model.id}`} className="text-xs font-normal text-brand-600 hover:underline dark:text-brand-400">
          {model.name}
        </Link>
      </p>
      <ProfilePictures model={model} deviceName={deviceName} />
    </section>
  );
}
