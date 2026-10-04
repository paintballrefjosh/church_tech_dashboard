"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  Cog,
  LayoutDashboard,
  LifeBuoy,
  Network,
  Plus,
  Search,
  StickyNote,
  Users,
} from "lucide-react";
import { KIND_META, hrefForHit, type SearchHit as Hit } from "@/lib/search-kinds";

/**
 * Cmd+K / Ctrl+K command palette. Combines:
 *   - Global search across tickets / notes / wiki / monitors (Meilisearch)
 *   - Navigation jumps to top-level pages
 *   - Quick-create entry points (just route navigation for now)
 *
 * Mounted once at the layout level; open state lives here. Search is
 * debounced to avoid hammering Meili on every keystroke.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Search debounce.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}&limit=10`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (r.ok) {
          const body = (await r.json()) as { hits: Hit[] };
          setHits(body.hits ?? []);
        }
      } catch {
        setHits([]);
      }
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  function go(href: string) {
    setOpen(false);
    setQ("");
    router.push(href);
  }

  if (!open) return null;
  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24"
    >
      <div
        className="absolute inset-0 bg-slate-900/40"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div className="fx-solid relative w-full max-w-xl overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-2 border-b border-slate-300 px-3 py-2 dark:border-slate-700">
          <Search className="h-4 w-4 text-slate-400" aria-hidden />
          <Command.Input
            value={q}
            onValueChange={setQ}
            placeholder="Search or jump to…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            autoFocus
          />
          <kbd className="rounded border border-slate-300 px-1 text-[10px] text-slate-500 dark:border-slate-600">
            esc
          </kbd>
        </div>
        <Command.List className="max-h-[24rem] overflow-y-auto p-1 text-sm">
          <Command.Empty className="p-4 text-center text-xs text-slate-500">
            No results.
          </Command.Empty>

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
                    <Icon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                    <span className="truncate">{h.title}</span>
                    <span className="ml-auto text-[10px] uppercase text-slate-400">
                      {kindMeta?.label ?? h.kind}
                    </span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          ) : null}

          <Command.Group heading="Jump to">
            {NAV_COMMANDS.map((c) => (
              <Command.Item
                key={c.href}
                value={`nav ${c.label}`}
                onSelect={() => go(c.href)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"
              >
                <c.icon className="h-4 w-4 text-slate-500" aria-hidden />
                <span>{c.label}</span>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Create">
            {CREATE_COMMANDS.map((c) => (
              <Command.Item
                key={c.href}
                value={`create ${c.label}`}
                onSelect={() => go(c.href)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"
              >
                <Plus className="h-4 w-4 text-slate-500" aria-hidden />
                <span>{c.label}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

const NAV_COMMANDS = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Tickets", href: "/tickets", icon: LifeBuoy },
  { label: "Wiki", href: "/wiki", icon: BookOpen },
  { label: "Notes", href: "/notes", icon: StickyNote },
  { label: "Monitoring", href: "/monitoring", icon: Activity },
  { label: "Network", href: "/monitoring/network", icon: Network },
  { label: "Users (admin)", href: "/admin/users", icon: Users },
  { label: "Settings (admin)", href: "/admin/settings", icon: Cog },
] as const;

const CREATE_COMMANDS = [
  { label: "New ticket", href: "/tickets/new" },
  { label: "New wiki page", href: "/wiki/new" },
] as const;
