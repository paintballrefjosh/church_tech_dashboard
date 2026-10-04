"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Server,
  Activity,
  Wifi,
  Network,
  Globe,
  Ticket,
  TicketPlus,
  BookPlus,
  NotebookPen,
  BookText,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import type { InfraSummary, Note, Ticket as TicketType, TicketStatus, WikiPage } from "@church/shared";

type Tone = "brand" | "amber" | "sky" | "emerald";

// Solid, dark-enough gradients so white text is always readable (no per-theme
// tuning, no color clash) — the whole tile becomes a coloured touch button.
const TONE: Record<Tone, string> = {
  brand: "bg-gradient-to-br from-brand-600 to-brand-800",
  amber: "bg-gradient-to-br from-amber-600 to-orange-700",
  sky: "bg-gradient-to-br from-sky-600 to-blue-700",
  emerald: "bg-gradient-to-br from-emerald-600 to-teal-700",
};

// Text shadow keeps the number/label crisp where they overlap the watermark.
const TEXT_SHADOW = "[text-shadow:0_1px_3px_rgba(0,0,0,0.35)]";

/**
 * The whole tile as one big touch button: a giant faded icon fills the card and
 * the count + label sit on top in white. The entire card links to its section.
 * Used for the tickets / notes / wiki tiles (rendered header-less via
 * TileShell's "button" variant).
 */
function CountCard({
  href,
  value,
  label,
  Icon,
  tone,
}: {
  href: string;
  value: number;
  label: string;
  Icon: LucideIcon;
  tone: Tone;
}) {
  return (
    <Link
      href={href}
      className={`relative flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-3xl text-white shadow-md transition hover:brightness-110 active:scale-[0.97] ${TONE[tone]}`}
    >
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
        <Icon className="h-1/2 w-1/2 text-white/[0.18]" />
      </span>
      <span className={`relative text-4xl font-bold tabular-nums ${TEXT_SHADOW}`}>{value}</span>
      <span className={`relative px-3 text-center text-sm font-semibold ${TEXT_SHADOW}`}>{label}</span>
    </Link>
  );
}

/**
 * Shared empty state for tiles with no content yet — a centred, muted icon over
 * a short line and an optional call-to-action, so an empty tile reads as
 * intentional rather than unfinished.
 */
function TileEmpty({
  Icon,
  text,
  actionHref,
  actionLabel,
}: {
  Icon: LucideIcon;
  text: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-6 text-center">
      <Icon className="h-8 w-8 text-slate-300 dark:text-slate-600" aria-hidden />
      <p className="text-xs text-slate-500 dark:text-slate-400">{text}</p>
      {actionHref && actionLabel ? (
        <Link href={actionHref} className="text-xs font-medium text-brand-600 hover:underline">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function TicketsSummaryTile({ initialTickets }: { initialTickets?: TicketType[] }) {
  const [tickets, setTickets] = useState<TicketType[] | null>(initialTickets ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Skip the fetch when the server-rendered parent already passed us data.
    if (initialTickets) return;
    fetch("/api/tickets?scope=own&limit=50", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setError(`failed (${r.status})`);
          return;
        }
        setTickets((await r.json()) as TicketType[]);
      })
      .catch(() => setError("failed"));
  }, [initialTickets]);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!tickets) return <p className="text-xs text-slate-400">Loading…</p>;

  const counts: Record<TicketStatus, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
  for (const t of tickets) counts[t.status as TicketStatus]++;

  return (
    <CountCard
      href="/tickets"
      value={counts.open}
      label={counts.open === 1 ? "Open ticket" : "Open tickets"}
      Icon={Ticket}
      tone="brand"
    />
  );
}

export function NotesRecentTile({ initialNotes }: { initialNotes?: Note[] }) {
  const [notes, setNotes] = useState<Note[] | null>(initialNotes ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialNotes) return;
    fetch("/api/notes", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setError(`failed (${r.status})`);
          return;
        }
        setNotes((await r.json()) as Note[]);
      })
      .catch(() => setError("failed"));
  }, [initialNotes]);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!notes) return <p className="text-xs text-slate-400">Loading…</p>;

  return (
    <CountCard
      href="/notes"
      value={notes.length}
      label={notes.length === 1 ? "Note" : "Notes"}
      Icon={NotebookPen}
      tone="amber"
    />
  );
}

export function WikiRecentTile({ initialPages }: { initialPages?: WikiPage[] }) {
  const [pages, setPages] = useState<WikiPage[] | null>(initialPages ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPages) return;
    fetch("/api/wiki", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setError(`failed (${r.status})`);
          return;
        }
        setPages((await r.json()) as WikiPage[]);
      })
      .catch(() => setError("failed"));
  }, [initialPages]);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!pages) return <p className="text-xs text-slate-400">Loading…</p>;

  return (
    <CountCard
      href="/wiki"
      value={pages.length}
      label={pages.length === 1 ? "Wiki page" : "Wiki pages"}
      Icon={BookText}
      tone="sky"
    />
  );
}

/**
 * One row of the consolidated monitoring tile: an area's up (green) / down
 * (red) / total counts. `status` distinguishes a healthy read from a source
 * that's unconfigured or errored, so those rows show a muted note instead of
 * misleading zeros.
 */
interface OverviewRow {
  key: string;
  label: string;
  href: string;
  Icon: LucideIcon;
  up: number;
  down: number;
  total: number;
  status: "ok" | "unconfigured" | "error";
  note?: string;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function buildOverviewRows(
  mon: unknown,
  infra: unknown,
  unifi: unknown,
  cisco: unknown,
  dns: unknown,
): OverviewRow[] {
  const rows: OverviewRow[] = [];

  // Infrastructure (host / Docker / Proxmox targets). Degraded targets are a
  // problem, so they count toward "down" (red); total is every target.
  const i = infra as InfraSummary | null;
  if (i?.targets) {
    const { up, degraded, down } = i.targets;
    rows.push({
      key: "infra",
      label: "Infrastructure",
      href: "/monitoring/infra",
      Icon: Server,
      up,
      down: down + degraded,
      total: up + degraded + down,
      status: "ok",
    });
  } else {
    rows.push({ key: "infra", label: "Infrastructure", href: "/monitoring/infra", Icon: Server, up: 0, down: 0, total: 0, status: "error", note: "unavailable" });
  }

  // Services (uptime monitors). "unknown" monitors are neither up nor down but
  // still count in the total.
  const m = mon as { up?: number; down?: number; total?: number } | null;
  if (m && typeof m.total === "number") {
    rows.push({
      key: "services",
      label: "Services",
      href: "/monitoring",
      Icon: Activity,
      up: m.up ?? 0,
      down: m.down ?? 0,
      total: m.total ?? 0,
      status: "ok",
    });
  } else {
    rows.push({ key: "services", label: "Services", href: "/monitoring", Icon: Activity, up: 0, down: 0, total: 0, status: "error", note: "unavailable" });
  }

  // Network (UniFi devices).
  const u = unifi as
    | { configured?: boolean; reachable?: boolean; devices?: { online?: number; offline?: number; total?: number } }
    | null;
  if (!u || u.configured === false) {
    rows.push({ key: "unifi", label: "Network (UniFi)", href: "/monitoring/network", Icon: Wifi, up: 0, down: 0, total: 0, status: "unconfigured", note: "not configured" });
  } else if (u.reachable === false) {
    rows.push({ key: "unifi", label: "Network (UniFi)", href: "/monitoring/network", Icon: Wifi, up: 0, down: 0, total: 0, status: "error", note: "unreachable" });
  } else {
    const d = u.devices ?? {};
    rows.push({
      key: "unifi",
      label: "Network (UniFi)",
      href: "/monitoring/network",
      Icon: Wifi,
      up: d.online ?? 0,
      down: d.offline ?? 0,
      total: d.total ?? 0,
      status: "ok",
    });
  }

  // Switches (Cisco). A switch is "up" when reachable, "down" otherwise.
  if (Array.isArray(cisco)) {
    const switches = cisco as Array<{ reachable?: boolean }>;
    const down = switches.filter((s) => s.reachable === false).length;
    rows.push({
      key: "cisco",
      label: "Switches",
      href: "/monitoring/network-cisco",
      Icon: Network,
      up: switches.length - down,
      down,
      total: switches.length,
      status: "ok",
    });
  } else {
    rows.push({ key: "cisco", label: "Switches", href: "/monitoring/network-cisco", Icon: Network, up: 0, down: 0, total: 0, status: "error", note: "unavailable" });
  }

  // DNS (Technitium cluster nodes). A single unclustered server, or a token
  // without the node list, counts as one node.
  const n = dns as { configured?: boolean; reachable?: boolean; nodes?: unknown[] | null; unreachableNodes?: number } | null;
  if (!n || n.configured === false) {
    rows.push({ key: "dns", label: "DNS", href: "/dns", Icon: Globe, up: 0, down: 0, total: 0, status: "unconfigured", note: "not configured" });
  } else if (n.reachable === false) {
    rows.push({ key: "dns", label: "DNS", href: "/dns", Icon: Globe, up: 0, down: 0, total: 0, status: "error", note: "primary unreachable" });
  } else {
    const total = n.nodes?.length || 1;
    const down = n.unreachableNodes ?? 0;
    rows.push({ key: "dns", label: "DNS", href: "/dns", Icon: Globe, up: total - down, down, total, status: "ok" });
  }

  return rows;
}

/**
 * Consolidated monitoring tile: one row per area (Infrastructure, Services,
 * Network/UniFi, Switches/Cisco, DNS) with up (green), down (red), and total counts.
 * Replaces the former separate monitoring / infra / network tiles.
 */
export function MonitoringOverviewTile() {
  const [rows, setRows] = useState<OverviewRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [mon, infra, unifi, cisco, dns] = await Promise.all([
        getJson("/api/monitors/summary"),
        getJson("/api/infra/summary"),
        getJson("/api/unifi/summary"),
        getJson("/api/cisco/switches"),
        getJson("/api/dns/summary"),
      ]);
      if (!cancelled) setRows(buildOverviewRows(mon, infra, unifi, cisco, dns));
    }
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!rows) return <p className="text-xs text-slate-400">Loading…</p>;

  return (
    <div className="flex h-full flex-col">
      <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 py-2">
            <r.Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <Link href={r.href} className="min-w-0 flex-1 truncate font-medium hover:underline">
              {r.label}
            </Link>
            <StatusPill row={r} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One-glance health for a monitoring row: a calm green "All up" when nothing's
 * wrong, a red "N down" only when something is, and a muted note when the source
 * is unconfigured/unavailable. Replaces the up/down/total number triple so a
 * healthy dashboard reads as quiet.
 */
function StatusPill({ row }: { row: OverviewRow }) {
  if (row.status !== "ok") {
    return <span className="text-xs text-slate-400 dark:text-slate-500">{row.note}</span>;
  }
  if (row.total === 0) {
    return <span className="text-xs text-slate-400 dark:text-slate-500">none</span>;
  }
  const problem = row.down > 0;
  const cls = problem
    ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
    : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300";
  const dot = problem ? "bg-rose-500" : "bg-emerald-500";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {problem ? `${row.down} down` : "All up"}
    </span>
  );
}

interface PcPlan {
  id: string;
  title: string;
  sortDate: string | null;
  seriesTitle: string | null;
  serviceTypeId: string;
  serviceTypeName: string | null;
}
interface PcAssignment {
  positionName: string;
  teamMemberId: string;
  pcPersonId: string | null;
  pcPersonName: string;
  status: string | null;
  localUserId: string | null;
}

export function PlanningCenterNextServiceTile() {
  const [plan, setPlan] = useState<PcPlan | null>(null);
  const [times, setTimes] = useState<{ id: string; startsAt: string | null; description: string | null }[]>([]);
  const [assignments, setAssignments] = useState<PcAssignment[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unconfigured" | "empty" | "error">(
    "loading",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const h = await fetch("/api/planning-center/health", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!h.ok) {
          if (!cancelled) {
            setState("error");
            setErrorMsg(`health (${h.status})`);
          }
          return;
        }
        const health = (await h.json()) as { configured: boolean; reachable: boolean; error: string | null };
        if (!health.configured) {
          if (!cancelled) setState("unconfigured");
          return;
        }
        if (!health.reachable) {
          if (!cancelled) {
            setState("error");
            setErrorMsg(health.error ?? "unreachable");
          }
          return;
        }
        const plansRes = await fetch("/api/planning-center/plans?limit=1", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!plansRes.ok) throw new Error(`plans (${plansRes.status})`);
        const plans = (await plansRes.json()) as PcPlan[];
        const next = plans[0];
        if (!next) {
          if (!cancelled) setState("empty");
          return;
        }
        const detailRes = await fetch(
          `/api/planning-center/plans/${encodeURIComponent(next.serviceTypeId)}/${encodeURIComponent(next.id)}`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!detailRes.ok) throw new Error(`detail (${detailRes.status})`);
        const detail = (await detailRes.json()) as {
          plan: PcPlan | null;
          times: { id: string; startsAt: string | null; description: string | null }[];
          assignments: PcAssignment[];
        };
        if (cancelled) return;
        setPlan(detail.plan ?? next);
        setTimes(detail.times ?? []);
        setAssignments(detail.assignments ?? []);
        setState("ready");
      } catch (err) {
        if (!cancelled) {
          setState("error");
          setErrorMsg((err as Error).message);
        }
      }
    }
    void load();
    // Refresh every 5 minutes — PC data rarely changes mid-day, no need to
    // poll harder than that.
    const t = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (state === "loading") return <p className="text-xs text-slate-400">Loading…</p>;
  if (state === "unconfigured") {
    return (
      <p className="text-xs text-slate-500">
        Planning Center isn&apos;t configured.{" "}
        <Link href="/admin/settings/planning_center" className="text-brand-600 underline">
          Configure
        </Link>{" "}
        to enable.
      </p>
    );
  }
  if (state === "empty") {
    return <p className="text-xs text-slate-500">No upcoming services.</p>;
  }
  if (state === "error") {
    return <p className="text-xs text-rose-600">Couldn&apos;t load: {errorMsg ?? "unknown"}</p>;
  }
  if (!plan) return null;

  // Group assignments by position so the same position with multiple people
  // (e.g. two vocalists) renders as one row.
  const byPosition = new Map<string, PcAssignment[]>();
  for (const a of assignments) {
    const list = byPosition.get(a.positionName) ?? [];
    list.push(a);
    byPosition.set(a.positionName, list);
  }
  const positions = [...byPosition.keys()].sort();

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2">
        <div className="text-sm font-semibold">
          <Link href={`/planning-center/${plan.serviceTypeId}/${plan.id}`} className="hover:underline">
            {plan.title}
          </Link>
        </div>
        {plan.seriesTitle ? (
          <div className="text-xs text-slate-500 dark:text-slate-400">{plan.seriesTitle}</div>
        ) : null}
        {times.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide text-slate-500">
            {times.slice(0, 3).map((t) => (
              <span key={t.id} className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
                {t.startsAt ? new Date(t.startsAt).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                }) : "—"}
                {t.description ? ` · ${t.description}` : ""}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {positions.length === 0 ? (
        <p className="text-xs text-slate-500">No team members assigned yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-auto text-sm">
          {positions.map((p) => (
            <li key={p} className="flex items-baseline gap-2">
              <span className="w-28 shrink-0 truncate text-xs uppercase tracking-wide text-slate-500">
                {p}
              </span>
              <span className="flex-1">
                {byPosition.get(p)!.map((a, i) => (
                  <span key={a.teamMemberId}>
                    {i > 0 ? ", " : ""}
                    <span
                      className={
                        a.localUserId
                          ? "font-medium text-brand-700 dark:text-brand-300"
                          : "text-slate-700 dark:text-slate-200"
                      }
                      title={a.localUserId ? "Linked to a local user" : undefined}
                    >
                      {a.pcPersonName}
                    </span>
                    {a.status === "D" ? (
                      <span className="ml-1 text-[10px] text-rose-500">(declined)</span>
                    ) : a.status === "U" ? (
                      <span className="ml-1 text-[10px] text-slate-400">(unconfirmed)</span>
                    ) : null}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface OpenTask {
  taskId: string;
  eventId: string;
  title: string;
  positionName: string | null;
  eventName: string;
  scheduledAt: string | null;
}

export function MyChecklistsTile({ limit = 5 }: { limit?: number }) {
  const [tasks, setTasks] = useState<OpenTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/checklists/my/open-tasks", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!r.ok) {
          if (!cancelled) setError(`failed (${r.status})`);
          return;
        }
        if (!cancelled) setTasks((await r.json()) as OpenTask[]);
      } catch {
        if (!cancelled) setError("failed");
      }
    }
    void load();
    // Light poll so a fresh assignment shows up without a reload.
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!tasks) return <p className="text-xs text-slate-400">Loading…</p>;
  if (tasks.length === 0) {
    return (
      <TileEmpty
        Icon={ListChecks}
        text="No open tasks assigned to you."
        actionHref="/checklists"
        actionLabel="View all checklists →"
      />
    );
  }

  // Group by event so multiple tasks on the same event collapse visually.
  const byEvent = new Map<
    string,
    { name: string; scheduledAt: string | null; rows: OpenTask[] }
  >();
  for (const t of tasks) {
    const cur = byEvent.get(t.eventId) ?? {
      name: t.eventName,
      scheduledAt: t.scheduledAt,
      rows: [],
    };
    cur.rows.push(t);
    byEvent.set(t.eventId, cur);
  }
  const events = [...byEvent.entries()].slice(0, limit);

  return (
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 space-y-3 overflow-auto text-sm">
        {events.map(([eventId, g]) => (
          <li key={eventId}>
            <div className="flex items-center justify-between">
              <Link href={`/checklists/${eventId}`} className="text-sm font-medium hover:underline">
                {g.name}
              </Link>
              {g.scheduledAt ? (
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {new Date(g.scheduledAt).toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              ) : null}
            </div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {g.rows.slice(0, 5).map((t) => (
                <li key={t.taskId} className="truncate text-slate-600 dark:text-slate-400">
                  ◦ {t.title}
                  {t.positionName ? (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">
                      {t.positionName}
                    </span>
                  ) : null}
                </li>
              ))}
              {g.rows.length > 5 ? (
                <li className="text-[10px] text-slate-500">… and {g.rows.length - 5} more</li>
              ) : null}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function QuickLinksTile() {
  // Just the "create" shortcuts — the section links they used to sit beside are
  // already one click away in the top nav, so they were pure duplication.
  const links: { href: string; label: string; Icon: LucideIcon }[] = [
    { href: "/tickets/new", label: "New ticket", Icon: TicketPlus },
    { href: "/wiki/new", label: "New page", Icon: BookPlus },
    { href: "/notes", label: "New note", Icon: NotebookPen },
  ];
  return (
    <div className="grid h-full grid-cols-3 grid-rows-1 gap-2">
      {links.map(({ href, label, Icon }) => (
        <Link
          key={href}
          href={href}
          className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-300 p-2 text-center transition hover:border-brand-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <Icon className="h-6 w-6 text-brand-600 dark:text-brand-400" aria-hidden />
          <span className="text-xs font-medium leading-tight">{label}</span>
        </Link>
      ))}
    </div>
  );
}
