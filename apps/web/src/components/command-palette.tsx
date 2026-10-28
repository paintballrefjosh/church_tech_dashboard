"use client";

import { Command, defaultFilter } from "cmdk";
import { useRouter, usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { signOut } from "next-auth/react";
import { Search } from "lucide-react";
import { KIND_META, hrefForHit } from "@/lib/search-kinds";
import { useGlobalSearch } from "@/lib/use-global-search";
import {
  GROUP_ORDER,
  paletteCommands,
  type Access,
  type PaletteCommand,
  type PaletteUser,
  type RunCommand,
} from "@/lib/palette";

interface Toast {
  tone: "ok" | "err";
  text: string;
}

async function failure(r: Response): Promise<string> {
  const body = (await r.json().catch(() => ({}))) as { message?: unknown };
  if (typeof body.message === "string") return body.message;
  if (Array.isArray(body.message)) return body.message.join(", ");
  return r.status === 403 ? "You do not have permission to do that." : `That did not work (${r.status}).`;
}

/**
 * Cmd+K / Ctrl+K command palette. Search results (Meilisearch), then the commands this person can use here
 * (`paletteCommands`, in lib/palette.ts: what they can do with the ticket or wiki page they are on, actions such as
 * pausing alerts, create, and pages to go to). An action reuses the same audited API routes as the page's own buttons; one
 * that changes what other people see asks for confirmation first. The result appears as a short message after the
 * palette closes.
 *
 * Mounted once at the layout level; open state lives here. Search is debounced to avoid hammering Meili on every keystroke.
 */
/** Opens the assistant's slide-over panel (components/assistant-panel.tsx); `detail.question` is asked at once when set. */
export const ASSISTANT_OPEN_EVENT = "assistant:open";
/** The `value` of the "Ask the assistant" entry: a typed question rarely matches it by letters, so it always scores a little. */
const ASK_VALUE = "assistant-ask";
const ASK_ID = "act:assistant-ask";
const paletteFilter = (value: string, search: string, keywords?: string[]) =>
  value === ASK_VALUE ? (search.trim() ? 0.0001 : 1) : (defaultFilter?.(value, search, keywords) ?? 0);

export function CommandPalette({ access }: { access: Access }) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<PaletteUser | null>(null);
  const [alertsPaused, setAlertsPaused] = useState<boolean | null>(null);
  const [pending, setPending] = useState<RunCommand | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { q, setQ, hits, clear } = useGlobalSearch({ limit: 10, debounceMs: 150 });

  const say = useCallback((t: Toast) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  // Global Cmd/Ctrl+K toggle. `data-palette-ready` tells a test (or a script) the keystroke will now be heard: before the
  // page has loaded in the browser it does nothing.
  useEffect(() => {
    document.documentElement.dataset.paletteReady = "1";
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Remember where focus was: nothing "triggers" the palette, so the dialog cannot hand focus back by itself.
        if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]')) opener.current = document.activeElement;
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      delete document.documentElement.dataset.paletteReady;
    };
  }, []);

  // When it closes, focus goes back to what had it (a keyboard user must not be dropped at the top of the page).
  useEffect(() => {
    if (open) return;
    const el = opener.current;
    opener.current = null;
    // After the dialog's own focus handling (it runs on a timer queued while it unmounts).
    const t = setTimeout(() => {
      if (el && document.contains(el)) el.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  // Who the person is (id and permissions) and whether alerts are paused are read when the palette opens, so what is
  // offered matches the moment: "Resume alerts" only while they are paused.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) return;
        const body = (await r.json()) as { id?: string; permissions?: string[] };
        if (cancelled || !body.id) return;
        const user: PaletteUser = { id: body.id, permissions: body.permissions ?? [], access };
        setMe(user);
        if (user.permissions.includes("monitors:write:any")) {
          const m = await fetch("/api/v1/monitors/maintenance", { credentials: "same-origin", cache: "no-store" });
          if (m.ok && !cancelled) setAlertsPaused(((await m.json()) as { enabled: boolean }).enabled === true);
        }
      } catch {
        /* the palette still searches and lists nothing it cannot be sure of */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, access]);

  function close() {
    setOpen(false);
    setPending(null);
    clear();
  }

  function go(href: string) {
    close();
    router.push(href);
  }

  async function execute(c: RunCommand) {
    setBusy(true);
    const json = { "content-type": "application/json" };
    const send = (path: string, method: string, body?: unknown) =>
      fetch(path, { method, credentials: "same-origin", headers: body === undefined ? undefined : json, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      switch (c.action) {
        case "theme": {
          const next = resolvedTheme === "dark" ? "light" : "dark";
          setTheme(next);
          close();
          say({ tone: "ok", text: `Switched to ${next} mode.` });
          return;
        }
        case "copy-link": {
          close();
          try {
            await navigator.clipboard.writeText(window.location.href);
            say({ tone: "ok", text: "Link copied." });
          } catch {
            say({ tone: "err", text: "Could not copy the link here." });
          }
          return;
        }
        case "sign-out": {
          close();
          // Same order as the user menu: end this browser's session on the server first, whatever happens to that call.
          await fetch("/api/me/sessions/current", { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
          void signOut({ redirectTo: "/signin" });
          return;
        }
        case "notifications-read-all": {
          const r = await send("/api/v1/notifications/read-all", "POST");
          close();
          if (!r.ok) return say({ tone: "err", text: await failure(r) });
          window.dispatchEvent(new CustomEvent("notifications:changed", { detail: { setTo: 0 } }));
          say({ tone: "ok", text: "All notifications marked as read." });
          router.refresh();
          return;
        }
        case "alerts-pause":
        case "alerts-resume": {
          const pausing = c.action === "alerts-pause";
          const r = await send("/api/v1/monitors/maintenance", "POST", pausing ? { enabled: true, minutes: Number(c.arg) } : { enabled: false });
          close();
          if (!r.ok) return say({ tone: "err", text: await failure(r) });
          const state = (await r.json()) as { enabled: boolean; until: string | null };
          setAlertsPaused(state.enabled);
          say({
            tone: "ok",
            text: state.enabled
              ? `Alerts paused${state.until ? ` until ${new Date(state.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.`
              : "Alerts are back on.",
          });
          window.dispatchEvent(new Event("monitoring:health-refresh"));
          router.refresh();
          return;
        }
        case "ticket-take":
        case "ticket-resolve":
        case "ticket-waiting": {
          const body =
            c.action === "ticket-take" ? { assignedUserId: me?.id } : { status: c.action === "ticket-resolve" ? "resolved" : "waiting" };
          const r = await send(`/api/v1/tickets/${c.arg}`, "PATCH", body);
          close();
          if (!r.ok) return say({ tone: "err", text: await failure(r) });
          say({ tone: "ok", text: c.action === "ticket-take" ? "The ticket is yours." : c.action === "ticket-resolve" ? "Ticket marked resolved." : "Ticket is waiting on the requester." });
          router.refresh();
          return;
        }
        case "assistant-ask": {
          const question = q.trim();
          close();
          window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT, { detail: { question } }));
          return;
        }
        case "wiki-confirm": {
          const r = await send(`/api/v1/wiki/${c.arg}/review`, "POST");
          close();
          if (!r.ok) return say({ tone: "err", text: await failure(r) });
          say({ tone: "ok", text: "Marked as still correct." });
          router.refresh();
          return;
        }
      }
    } catch {
      close();
      say({ tone: "err", text: "That did not work. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  function choose(c: PaletteCommand) {
    if (c.kind === "go") return go(c.href);
    if (c.confirm) return setPending(c);
    void execute(c);
  }

  const commands = paletteCommands({ user: me, pathname, alertsPaused, dark: resolvedTheme === "dark" });
  const askCommand = commands.find((c) => c.id === ASK_ID);
  const asking = q.trim() !== "";

  return (
    <>
      {open ? (
        <Command.Dialog
          open={open}
          onOpenChange={(v) => {
            // Escape backs out of a confirmation before it closes the palette.
            if (!v && pending) return setPending(null);
            if (!v) return close();
            setOpen(true);
          }}
          label="Command palette"
          filter={paletteFilter}
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24"
        >
          <div className="absolute inset-0 bg-slate-900/40" onClick={close} aria-hidden />
          <div className="fx-solid relative w-full max-w-xl overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            {pending ? (
              <div className="p-4" data-testid="palette-confirm" role="group" aria-label="Confirm">
                <h2 className="text-sm font-semibold">{pending.label}?</h2>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{pending.confirm}</p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPending(null)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    autoFocus
                    disabled={busy}
                    onClick={() => void execute(pending)}
                    data-testid="palette-confirm-go"
                    className="rounded-md bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {pending.label}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-slate-300 px-3 py-2 dark:border-slate-700">
                  <Search className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
                  <Command.Input
                    value={q}
                    onValueChange={setQ}
                    placeholder="Search, jump to a page or run a command..."
                    className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                    autoFocus
                  />
                  <kbd className="rounded border border-slate-300 px-1 text-[10px] text-slate-500 dark:text-slate-400 dark:border-slate-600">esc</kbd>
                </div>
                <Command.List className="max-h-[24rem] overflow-y-auto p-1 text-sm">
                  <Command.Empty className="p-4 text-center text-xs text-slate-500 dark:text-slate-400">No results.</Command.Empty>

                  {hits.length > 0 ? (
                    <Command.Group heading="Search results">
                      {hits.map((h) => {
                        const kindMeta = KIND_META[h.kind];
                        const Icon = kindMeta?.Icon ?? Search;
                        return (
                          <Command.Item
                            key={h.id}
                            value={`${h.kind} ${h.title}`}
                            onSelect={() => go(hrefForHit(h))}
                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"
                          >
                            <Icon className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
                            <span className="truncate">{h.title}</span>
                            <span className="ml-auto text-[10px] uppercase text-slate-500 dark:text-slate-400">{kindMeta?.label ?? h.kind}</span>
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  ) : null}

                  {GROUP_ORDER.map((group) => {
                    // While a question is typed the assistant entry moves to its own group at the end (see below).
                    const items = commands.filter((c) => c.group === group && !(c.id === ASK_ID && asking));
                    if (items.length === 0) return null;
                    return (
                      <Command.Group key={group} heading={group}>
                        {items.map((c) => (
                          <Command.Item
                            key={c.id}
                            value={`${c.group} ${c.label} ${c.keywords}`}
                            onSelect={() => choose(c)}
                            data-testid={`palette-${c.id}`}
                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"
                          >
                            <c.icon className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
                            <span>{c.label}</span>
                            {c.kind === "run" && c.confirm ? <span className="ml-auto text-[10px] uppercase text-slate-500 dark:text-slate-400">asks first</span> : null}
                          </Command.Item>
                        ))}
                      </Command.Group>
                    );
                  })}

                  {askCommand && asking ? (
                    // A typed question rarely matches "Ask the assistant" by letters, so it is always offered, last, so Enter
                    // still opens the best match (`paletteFilter` keeps it; cmdk does not move groups, DOM order decides).
                    <Command.Group heading="Assistant">
                      <Command.Item
                        value={ASK_VALUE}
                        onSelect={() => choose(askCommand)}
                        data-testid={`palette-${ASK_ID}`}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"
                      >
                        <askCommand.icon className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
                        <span className="truncate">Ask the assistant: {q.trim()}</span>
                      </Command.Item>
                    </Command.Group>
                  ) : null}
                </Command.List>
              </>
            )}
          </div>
        </Command.Dialog>
      ) : null}
      {/* What an action did, shown after the palette has closed. In a portal: the top bar can sit inside a frosted card
          surface, which would make "fixed" mean "inside the top bar". Only after mount, so the server and first client render agree. */}
      {mounted
        ? createPortal(
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
        {toast ? (
          <div
            role={toast.tone === "err" ? "alert" : "status"}
            data-testid="palette-toast"
            className={`pointer-events-auto rounded-md border px-4 py-2 text-sm shadow-lg ${
              toast.tone === "err"
                ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100"
                : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100"
            }`}
          >
            {toast.text}
          </div>
        ) : null}
      </div>,
            document.body,
          )
        : null}
    </>
  );
}
