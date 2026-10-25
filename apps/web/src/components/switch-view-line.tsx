"use client";

import Link from "next/link";
import { switchViewSentence, type SwitchView } from "@/lib/faceplates/custom";

/**
 * Says which device profile draws this switch and why ("matched on C3064PQ"), with a link for an admin to edit that profile or
 * set one up. Changing which profile a switch uses is in the Edit switch form.
 */
export function SwitchViewLine({ view, deviceModel, canWrite }: { view: SwitchView; deviceModel: string | null; canWrite: boolean }) {
  // Where an admin goes next: finish or edit the model in play, or make one for this model text.
  const link = !canWrite
    ? null
    : view.model
      ? { href: `/device-profiles/${view.model.id}`, text: view.layout?.source === "custom" ? `Edit ${view.model.name}` : `Finish ${view.model.name}` }
      : deviceModel && view.how === "none"
        ? { href: `/device-profiles?create=${encodeURIComponent(deviceModel)}`, text: `Set up a profile for ${deviceModel}` }
        : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-400" data-testid="switch-view-line">
      <span>{switchViewSentence(view, deviceModel)}</span>
      {link ? (
        <Link href={link.href} className="text-brand-600 hover:underline dark:text-brand-400">
          {link.text}
        </Link>
      ) : null}
    </div>
  );
}
