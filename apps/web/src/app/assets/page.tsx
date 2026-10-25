"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FileUp, Package, Plus, Printer, Search } from "lucide-react";
import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  PERMISSIONS,
  groupLocations,
  type Asset,
} from "@church/shared";
import { PageTitle } from "@/components/page-title";
import { HolderLine, RoomLink, StatusChip, can, useRooms, useViewer } from "@/components/assets-ui";
import { inputCls, useToasts, ToastStack } from "../monitoring/network-cisco/cisco-ui";
import { AssetFormModal } from "./asset-form";

type Holding = "" | "out" | "overdue" | "mine";
const HOLDING: Array<{ id: Holding; label: string }> = [
  { id: "", label: "Everything" },
  { id: "out", label: "Checked out" },
  { id: "overdue", label: "Overdue" },
  { id: "mine", label: "With me" },
];

/** The inventory: find an item, see who has it, check it out from its page, print labels for a selection. */
export default function AssetsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>}>
      <AssetsList />
    </Suspense>
  );
}

function AssetsList() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useViewer();
  const [rooms] = useRooms();
  const [rows, setRows] = useState<Asset[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [category, setCategory] = useState(params.get("category") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [locationId, setLocationId] = useState(params.get("locationId") ?? "");
  const [holding, setHolding] = useState<Holding>((params.get("holding") as Holding) ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const { toasts, show, dismiss } = useToasts();
  const staff = can(me, PERMISSIONS.ASSETS_WRITE_ANY);
  const admin = can(me, PERMISSIONS.ASSETS_ADMIN);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (category) p.set("category", category);
    if (status) p.set("status", status);
    if (locationId) p.set("locationId", locationId);
    if (holding) p.set("holding", holding);
    return p.toString();
  }, [q, category, status, locationId, holding]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/assets${query ? `?${query}` : ""}`, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setRows((await r.json()) as Asset[]);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    router.replace(`/assets${query ? `?${query}` : ""}`, { scroll: false });
    return () => clearTimeout(t);
  }, [load, query, router]);

  const allPicked = rows !== null && rows.length > 0 && rows.every((r) => picked.has(r.id));
  function toggle(id: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  if (forbidden) return <p className="text-sm text-slate-600 dark:text-slate-400">Your account does not have the Equipment module.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle icon={Package}>Equipment</PageTitle>
        <div className="flex flex-wrap gap-2">
          {picked.size > 0 ? (
            <Link
              href={`/print/assets?ids=${[...picked].join(",")}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Printer className="h-4 w-4" aria-hidden /> Print {picked.size} label{picked.size === 1 ? "" : "s"}
            </Link>
          ) : null}
          {admin ? (
            <Link
              href="/assets/import"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <FileUp className="h-4 w-4" aria-hidden /> Import
            </Link>
          ) : null}
          {staff ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> Add an item
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="relative min-w-[14rem] flex-1">
          <span className="sr-only">Search equipment</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
          <input className={`${inputCls} w-full pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tag, name, make, model or serial" />
        </label>
        <label>
          <span className="sr-only">Category</span>
          <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Any category</option>
            {ASSET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ASSET_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {ASSET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ASSET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Room</span>
          <select className={inputCls} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Any room</option>
            {groupLocations(rooms ?? []).map((g) =>
              g.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {g.building ? `${r.name} (${g.building})` : r.name}
                </option>
              )),
            )}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
        {HOLDING.map((h) => (
          <button
            key={h.id}
            type="button"
            aria-pressed={holding === h.id}
            onClick={() => setHolding(h.id)}
            className={`rounded-full border px-3 py-1 text-sm ${
              holding === h.id
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            }`}
          >
            {h.label}
          </button>
        ))}
      </div>

      {rows === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-400">
          {query ? "Nothing matches." : staff ? "No equipment recorded yet. Add an item, or import a spreadsheet." : "No equipment recorded yet."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Equipment">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Pick every item shown (to print labels)"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
                <th className="px-3 py-2">Tag</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Room</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Where it is</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/60">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Pick ${a.tag}`} checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    <Link href={`/assets/${a.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
                      {a.tag}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/assets/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {[ASSET_CATEGORY_LABELS[a.category], a.make, a.model].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <RoomLink room={a.location} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip status={a.status} />
                  </td>
                  <td className="px-3 py-2">
                    <HolderLine asset={a} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <AssetFormModal
          asset={null}
          rooms={rooms}
          onClose={() => setAdding(false)}
          onSaved={(a) => {
            setAdding(false);
            show(true, `Added ${a.tag}.`);
            router.push(`/assets/${a.id}`);
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
