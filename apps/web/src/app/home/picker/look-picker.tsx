"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Check, LayoutTemplate, Palette, X } from "lucide-react";
import { DASHBOARD_LOOKS, type LookId } from "@church/shared";
import { useHomeLook } from "../home-look-context";

/**
 * A thumbnail of a look in the current colour scheme. Some images are added later than the look
 * itself, so a missing file shows a neutral card (icon and name) instead of a broken image.
 */
function Thumbnail({ id, name, scheme }: { id: LookId; name: string; scheme: "light" | "dark" }) {
  const def = DASHBOARD_LOOKS.find((l) => l.id === id);
  const src = def ? def.thumbnails[scheme] : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return (
      <div
        data-testid="look-thumb-fallback"
        className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1 rounded border border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
      >
        <LayoutTemplate className="h-6 w-6" aria-hidden />
        <span className="text-xs font-medium">{name}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className="aspect-[16/10] w-full rounded border border-slate-200 object-cover object-top dark:border-slate-700"
    />
  );
}

async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { message?: string | string[]; error?: string };
    if (Array.isArray(j.message)) return j.message.join(", ");
    if (typeof j.message === "string") return j.message;
    if (typeof j.error === "string") return j.error;
  } catch {
    /* ignore */
  }
  return `Request failed (${r.status})`;
}

async function putTheme(theme: LookId | null): Promise<string | null> {
  const r = await fetch("/api/dashboard/prefs", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme }),
  });
  return r.ok ? null : readError(r);
}

/** Saves which optional sections are hidden on one look. The other looks' choices are re-read first and kept. */
async function putHiddenSections(look: LookId, hidden: string[]): Promise<string | null> {
  const current = await fetch("/api/dashboard/prefs", { credentials: "same-origin" });
  if (!current.ok) return readError(current);
  const prefs = (await current.json()) as { sections?: Record<string, string[]> };
  const r = await fetch("/api/dashboard/prefs", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sections: { ...(prefs.sections ?? {}), [look]: hidden } }),
  });
  return r.ok ? null : readError(r);
}

async function postDeviceLook(look: LookId | null): Promise<string | null> {
  const r = await fetch("/api/dashboard/device-look", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ look }),
  });
  return r.ok ? null : readError(r);
}

/**
 * Small "Change look" button that opens a dialog listing the looks this person may use. Any look
 * can render it; it reads the current look from HomeLookContext. Renders nothing outside the home
 * page, on a booth screen, or when there is nothing to choose between.
 */
export function LookPickerButton({ className }: { className?: string }) {
  const ctx = useHomeLook();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!ctx || ctx.kiosk) return null;
  if (ctx.available.length < 2 && ctx.source !== "device") return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        data-testid="look-picker-open"
        className={
          className ??
          "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 dark:border-slate-700 dark:hover:bg-slate-800"
        }
      >
        <Palette className="h-4 w-4" aria-hidden /> Change look
      </button>
      {open ? (
        <LookPickerDialog
          onClose={() => {
            setOpen(false);
            // The dialog is removed from the page, so put the focus back on the button that opened it.
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}

function LookPickerDialog({ onClose }: { onClose: () => void }) {
  const ctx = useHomeLook();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const scheme: "light" | "dark" = mounted && resolvedTheme === "dark" ? "dark" : "light";
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [deviceOnly, setDeviceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => ctx?.hiddenSections ?? []);

  // A native modal dialog gives the focus trap, Esc to close and inert background for free.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  if (!ctx) return null;
  const { look: current, source, available, siteDefault } = ctx;
  const looks = DASHBOARD_LOOKS.filter((l) => available.includes(l.id));

  async function apply(run: () => Promise<string | null>) {
    setBusy(true);
    setErr(null);
    const failure = await run();
    if (failure) {
      setErr(failure);
      setBusy(false);
      return;
    }
    // Drop a ?theme= preview from the address, or it would keep overriding what was just saved.
    const url = new URL(window.location.href);
    url.searchParams.delete("theme");
    router.replace(url.pathname + url.search);
    router.refresh();
    setBusy(false);
    onClose();
  }

  function choose(id: LookId) {
    void apply(async () => {
      if (deviceOnly) return postDeviceLook(id);
      // A look pinned to this device would still win over the account choice, so clear it.
      if (source === "device") {
        const cleared = await postDeviceLook(null);
        if (cleared) return cleared;
      }
      return putTheme(id);
    });
  }

  function useSiteDefault() {
    void apply(async () => {
      if (source === "device") {
        const cleared = await postDeviceLook(null);
        if (cleared) return cleared;
      }
      return putTheme(null);
    });
  }

  function stopDeviceLook() {
    void apply(() => postDeviceLook(null));
  }

  const currentDef = DASHBOARD_LOOKS.find((l) => l.id === current);
  const sections = currentDef?.optionalSections ?? [];

  async function toggleSection(id: string, shown: boolean) {
    const next = shown ? hiddenIds.filter((x) => x !== id) : [...hiddenIds, id];
    setBusy(true);
    setErr(null);
    const failure = await putHiddenSections(current, next);
    if (failure) {
      setErr(failure);
    } else {
      setHiddenIds(next);
      router.refresh();
    }
    setBusy(false);
  }

  const siteDefaultName = DASHBOARD_LOOKS.find((l) => l.id === siteDefault)?.name ?? siteDefault;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      data-testid="look-picker"
      className="fx-solid m-auto max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-3xl overflow-y-auto rounded-lg border border-slate-300 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            Choose a home page look
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Same information, shown differently. You can change this at any time.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 dark:hover:bg-slate-800"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div className="space-y-3 px-4 py-4">
        {source === "device" ? (
          <p
            className="flex flex-wrap items-center gap-2 rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-sm dark:border-brand-700 dark:bg-brand-700/20"
            data-testid="look-picker-device-note"
          >
            <span className="flex-1">This device is set to use its own look, whatever your account says.</span>
            <button
              type="button"
              disabled={busy}
              onClick={stopDeviceLook}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              Stop using a look just on this device
            </button>
          </p>
        ) : null}
        {source === "url" ? (
          <p className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
            You are previewing a look from the address. Choosing one below saves it.
          </p>
        ) : null}

        <ul className="grid gap-3 sm:grid-cols-2">
          {looks.map((l) => {
            const isCurrent = l.id === current;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => choose(l.id)}
                  aria-current={isCurrent ? "true" : undefined}
                  data-testid={`look-option-${l.id}`}
                  className={
                    "block w-full rounded-lg border p-2 text-left transition motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 " +
                    (isCurrent
                      ? "border-brand-600 bg-brand-50 dark:border-brand-500 dark:bg-brand-700/20"
                      : "border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")
                  }
                >
                  <Thumbnail id={l.id} name={l.name} scheme={scheme} />
                  <span className="mt-2 flex items-center gap-1.5 px-1 text-sm font-medium">
                    {l.name}
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                        <Check className="h-3 w-3" aria-hidden /> Current
                      </span>
                    ) : null}
                  </span>
                  <span className="block px-1 pb-1 text-xs text-slate-600 dark:text-slate-400">
                    {l.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {sections.length > 0 ? (
          <fieldset
            data-testid="look-sections"
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700"
          >
            <legend className="px-1 text-sm font-semibold">Sections on {currentDef?.name}</legend>
            <p className="mb-2 text-xs text-slate-600 dark:text-slate-400">
              Untick a section to hide it on this look. The rest of the page moves up to fill the space.
            </p>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {sections.map((sec) => (
                <label key={sec.id} className="flex min-h-[2rem] items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!hiddenIds.includes(sec.id)}
                    onChange={(e) => void toggleSection(sec.id, e.target.checked)}
                    data-testid={`look-section-${sec.id}`}
                    className="h-4 w-4 accent-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                  />
                  Show {sec.label.charAt(0).toLowerCase() + sec.label.slice(1)}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={deviceOnly}
            onChange={(e) => setDeviceOnly(e.target.checked)}
            className="h-4 w-4 accent-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          />
          Use on this device only
        </label>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
          <button
            type="button"
            disabled={busy}
            onClick={useSiteDefault}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Use the site default
          </button>
          <span className="text-xs text-slate-500 dark:text-slate-400">The site default is {siteDefaultName}.</span>
          <span role="alert" className="min-h-[1.25rem] text-sm text-rose-600 dark:text-rose-400">
            {err}
          </span>
        </div>
      </div>
    </dialog>
  );
}
