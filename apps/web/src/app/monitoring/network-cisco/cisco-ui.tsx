"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import type { CiscoSwitch } from "@church/shared";

/** True when the current user holds the monitoring admin tier ("network admin"). */
export function useCanWrite(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { permissions?: string[] } | null) => {
        if (!cancelled) setCan(Boolean(me?.permissions?.includes("monitors:write:any")));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return can;
}

export type SwStatus = "green" | "yellow" | "orange" | "red";

export function computeStatus(sw: CiscoSwitch): SwStatus {
  if (!sw.reachable) return "red";
  if (sw.configDrift) return "orange";
  if (sw.checkPortState && (sw.portsDownEnabled ?? 0) > 0) return "yellow";
  return "green";
}

const STATUS_CFG: Record<SwStatus, { label: string; cls: string; dot: string }> = {
  green: { label: "Online", cls: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  yellow: { label: "Port down", cls: "text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  orange: { label: "Drift", cls: "text-orange-700 dark:text-orange-300", dot: "bg-orange-500" },
  red: { label: "Down", cls: "text-rose-700 dark:text-rose-300", dot: "bg-rose-500" },
};

export function StatusPill({ status }: { status: SwStatus }) {
  const c = STATUS_CFG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${c.cls}`}>
      <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden />
      {c.label}
    </span>
  );
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/** Small toast-ish inline status line the pages reuse. */
/** How long a toast stays before it goes away on its own. */
export const TOAST_MS = 5000;

export interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

/** Toasts for the outcome of an action: each leaves after `TOAST_MS`, or when it is clicked. Render with `ToastStack`. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (ok: boolean, text: string) => {
      const id = ++nextId.current;
      setToasts((list) => [...list, { id, ok, text }].slice(-6));
      timers.current.set(id, setTimeout(() => dismiss(id), TOAST_MS));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  return { toasts, show, dismiss };
}

/** The toasts, stacked in the lower right of the window. A toast is a button: clicking it dismisses it. */
export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-testid="toast-stack"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[1100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onDismiss(t.id)}
          title="Click to dismiss"
          className={`pointer-events-auto rounded-md border px-3 py-2 text-left text-sm shadow-lg ${
            t.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** A spinner with a line of text, for work that is in progress (a push over SSH can take several seconds). */
export function PendingLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-sm text-brand-800 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-200"
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      {text}
    </p>
  );
}

export function StatusLine({ status }: { status: { ok: boolean; text: string } | null }) {
  if (!status) return null;
  return (
    <p
      role="status"
      className={`rounded-md border px-3 py-2 text-sm ${
        status.ok
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
      }`}
    >
      {status.text}
    </p>
  );
}

export const inputCls =
  "rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";
export const cardCls = "rounded-md border border-slate-300 p-4 dark:border-slate-800";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/**
 * A large viewer for long text (a switch config, a diff): nearly the whole window, scrolls inside, closes on Esc,
 * the backdrop or the X, and locks the page behind it. Portalled to <body> so no card or scroll container clips it.
 * `actions` sits in the header next to the close button.
 */
export function BigModal({
  title,
  subtitle,
  actions,
  onClose,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/60 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[94vh] w-full max-w-[min(96rem,100%)] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{title}</h3>
            {subtitle ? <div className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</div> : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
