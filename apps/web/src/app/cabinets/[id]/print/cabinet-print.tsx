"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { RACK_ITEM_STYLE_LABELS, topU, type RackDetail, type RackItemView } from "@church/shared";
import { RackElevation, drawnUnits } from "@/components/rack-elevation";
import { useSwitchModels } from "@/lib/use-switch-models";
import { PRINT_BASE_CSS } from "@/lib/print-css";
import type { RackSide } from "@/lib/rack-pictures";

type Show = "front" | "rear" | "both";

const SHOW_LABELS: Record<Show, string> = { front: "Front", rear: "Rear", both: "Front and rear" };

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** What the table beside the cabinet says for an item: its hostname (or name) and address. */
function rowText(it: RackItemView): { host: string; sub: string | null; ip: string } {
  const host = it.live.hostname || it.live.name;
  const kind = it.sourceKind === "custom" ? RACK_ITEM_STYLE_LABELS[it.style] : it.live.model;
  const sub = [it.live.name !== host ? it.live.name : null, kind].filter(Boolean).join(" - ");
  return { host: it.live.missing ? `${host} (not found)` : host, sub: sub || null, ip: it.live.ip ?? "" };
}

/**
 * The table that sits beside the cabinet. Its rows are the cabinet's rows (same grid, same `--u`), so each item's line is
 * level with the item drawn next to it and an empty slot is an empty line.
 */
function ItemsTable({ rows, items }: { rows: number; items: RackItemView[] }) {
  const gridRow = (it: RackItemView) => `${rows - topU(it) + 1} / span ${it.heightU}`;
  const taken = new Set<number>();
  for (const it of items) for (let u = it.startU; u <= topU(it); u++) taken.add(u);
  const freeUnits = Array.from({ length: rows }, (_, i) => i + 1).filter((u) => !taken.has(u));
  return (
    <div className="min-w-0 flex-1 text-slate-900">
      <div className="grid h-[var(--h)] grid-cols-[11mm_minmax(0,1fr)_25mm] items-end border-b border-slate-900 pb-0.5 text-[9px] font-semibold uppercase tracking-wide">
        <span>U</span>
        <span>Hostname</span>
        <span>IP address</span>
      </div>
      <div
        className="grid grid-cols-[11mm_minmax(0,1fr)_25mm] text-[10px] leading-tight"
        style={{ gridTemplateRows: `repeat(${rows}, var(--u))` }}
      >
        {/* A faint line for every free U, so a blank stretch can still be followed across from the cabinet. */}
        {freeUnits.map((u) => (
          <div key={`free${u}`} aria-hidden className="border-b border-slate-300" style={{ gridColumn: "1 / -1", gridRow: rows - u + 1 }} />
        ))}
        {items.map((it) => {
          const t = rowText(it);
          const cell = "flex flex-col justify-center overflow-hidden border-b border-slate-900 bg-white pr-1";
          return (
            <div key={it.id} className="contents">
              <span className={`${cell} font-mono tabular-nums`} style={{ gridColumn: 1, gridRow: gridRow(it) }}>
                {it.heightU > 1 ? `${it.startU}-${topU(it)}` : it.startU}
              </span>
              <span className={cell} style={{ gridColumn: 2, gridRow: gridRow(it) }}>
                <span className="truncate font-semibold">{t.host}</span>
                {t.sub && it.heightU > 1 ? <span className="truncate text-[8.5px] text-slate-600">{t.sub}</span> : null}
              </span>
              <span className={`${cell} font-mono`} style={{ gridColumn: 3, gridRow: gridRow(it) }}>
                <span className="truncate">{t.ip}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CabinetPrint() {
  const { id } = useParams<{ id: string }>();
  const { models } = useSwitchModels();
  const [rack, setRack] = useState<RackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>("front");
  const [pictures, setPictures] = useState(true);
  const [printed, setPrinted] = useState("");

  useEffect(() => {
    setPrinted(today());
    fetch(`/api/racks/${id}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (r.ok) setRack((await r.json()) as RackDetail);
        else setError(r.status === 404 ? "That cabinet does not exist." : `The cabinet could not be loaded (${r.status}).`);
      })
      .catch(() => setError("The cabinet could not be loaded."));
  }, [id]);

  const rows = rack ? drawnUnits(rack.units, rack.items) : 0;
  const sides: RackSide[] = show === "both" ? ["front", "rear"] : [show];
  // The cabinet fills the page height whatever its size: 42U comes out at about 5.7 mm a U on A4.
  const vars = useMemo<CSSProperties>(
    () => ({ ["--u" as string]: `min(6.2mm, calc(232mm / ${Math.max(rows, 1)}))`, ["--h" as string]: "5mm" }),
    [rows],
  );

  return (
    <main className="min-h-screen bg-slate-100 px-3 py-6 print:bg-white print:p-0 dark:bg-slate-900 print:dark:bg-white">
      <style>{PRINT_BASE_CSS}</style>
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center gap-3 print:hidden">
        <Link href={`/cabinets/${id}`} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to the cabinet
        </Link>
        <div role="group" aria-label="Print" className="ml-auto inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
          {(Object.keys(SHOW_LABELS) as Show[]).map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              onClick={() => setShow(s)}
              className={`px-2.5 py-1 text-xs ${i > 0 ? "border-l border-slate-300 dark:border-slate-700" : ""} ${
                show === s ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {SHOW_LABELS[s]}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={pictures} onChange={(e) => setPictures(e.target.checked)} /> Pictures
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Printer className="h-4 w-4" aria-hidden /> Print
        </button>
      </div>

      {error ? <p role="alert" className="mx-auto max-w-[210mm] text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}

      {rack ? (
        <article
          className="print-sheet mx-auto max-w-[210mm] bg-white p-[10mm] text-slate-900 shadow print:max-w-none print:p-0 print:shadow-none"
          style={vars}
          aria-label={`Printable sheet for ${rack.name}`}
        >
          <header className="mb-2 flex flex-wrap items-baseline gap-x-4 border-b border-slate-900 pb-1">
            <h1 className="text-base font-bold">{rack.name}</h1>
            {rack.location ? <span className="text-xs">{rack.location}</span> : null}
            <span className="text-xs">{rack.units}U</span>
            <span className="ml-auto text-[10px] text-slate-600">Printed {printed}</span>
          </header>

          <div className="flex items-start gap-2">
            {sides.includes("front") ? <Column title="Front" rack={rack} side="front" models={models ?? []} pictures={pictures} /> : null}
            <ItemsTable rows={rows} items={rack.items} />
            {sides.includes("rear") ? <Column title="Rear" rack={rack} side="rear" models={models ?? []} pictures={pictures} /> : null}
          </div>

          {rack.notes ? <p className="mt-3 whitespace-pre-wrap text-[10px]">{rack.notes}</p> : null}
        </article>
      ) : null}
    </main>
  );
}

function Column({ title, rack, side, models, pictures }: { title: string; rack: RackDetail; side: RackSide; models: Parameters<typeof RackElevation>[0]["models"]; pictures: boolean }) {
  return (
    <div className="w-[56mm] shrink-0">
      <div className="flex h-[var(--h)] items-end border-b border-slate-900 pb-0.5 text-[9px] font-semibold uppercase tracking-wide">{title}</div>
      <RackElevation units={rack.units} items={rack.items} models={models} side={side} variant="print" pictures={pictures} label={`${rack.name}, ${side} view`} />
    </div>
  );
}
