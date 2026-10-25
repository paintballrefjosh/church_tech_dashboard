"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileUp } from "lucide-react";
import { ASSET_CATEGORY_LABELS, ASSET_IMPORT_MAX_ROWS, PERMISSIONS, parseAssetCsv, type ImportAssetsResult, type ImportDateOrder } from "@church/shared";
import { PageTitle } from "@/components/page-title";
import { can, sendJson, useRooms, useViewer } from "@/components/assets-ui";
import { inputCls, cardCls } from "../../monitoring/network-cisco/cisco-ui";

/** The request body cap of the API (Fastify's default); a CSV of 2000 items is far below it, so this only catches odd files. */
const MAX_BODY_BYTES = 1_000_000;

const FIELD_LABELS: Record<string, string> = {
  tag: "Tag",
  name: "Name",
  category: "Category",
  make: "Make",
  model: "Model",
  serial: "Serial",
  room: "Room",
  status: "Status",
  lendable: "Can be lent",
  purchasedOn: "Bought on",
  cost: "Cost",
  warrantyUntil: "Warranty until",
  notes: "Notes",
};

/**
 * Import a spreadsheet saved as CSV. Everything is read and checked in the browser first (the same checks the API makes),
 * shown as a preview, and only then sent as one all-or-nothing request.
 */
export default function AssetImportPage() {
  const me = useViewer();
  const [rooms] = useRooms();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [order, setOrder] = useState<ImportDateOrder>("dmy");
  const [createRooms, setCreateRooms] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportAssetsResult | null>(null);

  const parsed = useMemo(() => (text === null ? null : parseAssetCsv(text, order)), [text, order]);
  const known = new Set((rooms ?? []).map((r) => r.name.toLowerCase()));
  const newRooms = parsed ? [...new Set(parsed.rows.map((r) => r.room.trim()).filter((n) => n && !known.has(n.toLowerCase())))] : [];

  async function pick(file: File | undefined) {
    setDone(null);
    setError(null);
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  }

  async function send() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const body = { rows: parsed.rows, createRooms };
      if (new Blob([JSON.stringify(body)]).size > MAX_BODY_BYTES) throw new Error("This file is too big to send at once; split it in two.");
      setDone(await sendJson<ImportAssetsResult>("/api/assets/import", "POST", body));
      setText(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (me && !can(me, PERMISSIONS.ASSETS_ADMIN)) return <p className="text-sm text-slate-600 dark:text-slate-400">Importing needs the Equipment admin tier.</p>;

  return (
    <div className="space-y-5">
      <Link href="/assets" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Equipment
      </Link>
      <PageTitle icon={FileUp}>Import equipment</PageTitle>
      <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Save the spreadsheet as CSV. The first row must be the headings; columns are recognised by name in any order (Name or Item is
        required; Tag, Category, Make, Model, Serial, Room, Status, Lendable, Purchased, Cost, Warranty and Notes are read when present,
        anything else is ignored). Items without a tag get the next number. At most {ASSET_IMPORT_MAX_ROWS} items at once, and nothing is
        saved unless every item can be.
      </p>

      {done ? (
        <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Imported {done.created} item{done.created === 1 ? "" : "s"}
          {done.roomsCreated.length ? ` and added ${done.roomsCreated.length} room${done.roomsCreated.length === 1 ? "" : "s"} (${done.roomsCreated.join(", ")})` : ""}.{" "}
          <Link href="/assets" className="font-medium underline">
            See the list
          </Link>
        </p>
      ) : null}

      <div className={`${cardCls} flex flex-wrap items-end gap-4`}>
        <label className="text-sm">
          <span className="block text-xs text-slate-500 dark:text-slate-400">CSV file</span>
          <input type="file" accept=".csv,text/csv" className="mt-1 text-sm" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-slate-500 dark:text-slate-400">Dates like 04/03/2026 mean</span>
          <select className={`${inputCls} mt-1`} value={order} onChange={(e) => setOrder(e.target.value as ImportDateOrder)}>
            <option value="dmy">4 March (day first)</option>
            <option value="mdy">April 3 (month first)</option>
            <option value="ymd">Year first (2026/03/04)</option>
          </select>
        </label>
      </div>

      {parsed ? (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="font-medium">{fileName}</span>: {parsed.rows.length} item{parsed.rows.length === 1 ? "" : "s"} ready
            {parsed.problems.length ? `, ${parsed.problems.length} with problems (left out until fixed in the file)` : ""}.
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Columns:{" "}
            {parsed.columns.map((c, i) => (
              <span key={i} className="mr-2">
                {c.heading || "(blank)"} {c.field ? `→ ${FIELD_LABELS[c.field]}` : "(ignored)"}
              </span>
            ))}
          </p>
          {parsed.problems.length ? (
            <ul role="alert" className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-rose-300 p-3 text-sm text-rose-800 dark:border-rose-800 dark:text-rose-200">
              {parsed.problems.map((p, i) => (
                <li key={i}>
                  Line {p.line}: {p.message}
                </li>
              ))}
            </ul>
          ) : null}
          {parsed.notes.length ? (
            <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-slate-600 dark:text-slate-400">
              {parsed.notes.map((p, i) => (
                <li key={i}>
                  Line {p.line}: {p.message}
                </li>
              ))}
            </ul>
          ) : null}
          {parsed.rows.length ? (
            <div className="max-h-96 overflow-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Preview">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Tag</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Make / model</th>
                    <th className="px-3 py-2">Room</th>
                    <th className="px-3 py-2">Bought</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {parsed.rows.slice(0, 200).map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 font-mono text-xs">{r.tag || <span className="text-slate-500 dark:text-slate-400">next</span>}</td>
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1.5">{ASSET_CATEGORY_LABELS[r.category]}</td>
                      <td className="px-3 py-1.5">{[r.make, r.model].filter(Boolean).join(" ")}</td>
                      <td className="px-3 py-1.5">
                        {r.room}
                        {r.room && !known.has(r.room.trim().toLowerCase()) ? <span className="ml-1 text-xs text-amber-800 dark:text-amber-300">(new)</span> : null}
                      </td>
                      <td className="px-3 py-1.5">{r.purchasedOn ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 200 ? <p className="p-2 text-xs text-slate-500 dark:text-slate-400">and {parsed.rows.length - 200} more</p> : null}
            </div>
          ) : null}
          {newRooms.length ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={createRooms} onChange={(e) => setCreateRooms(e.target.checked)} />
              <span>
                Add the {newRooms.length} room{newRooms.length === 1 ? "" : "s"} that do not exist yet ({newRooms.slice(0, 8).join(", ")}
                {newRooms.length > 8 ? " ..." : ""}). Untick to refuse the import instead.
              </span>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy || parsed.rows.length === 0 || parsed.problems.length > 0}
            onClick={() => void send()}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "Importing…" : `Import ${parsed.rows.length} item${parsed.rows.length === 1 ? "" : "s"}`}
          </button>
          {parsed.problems.length > 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">Fix the lines above in the spreadsheet and choose the file again; nothing is imported while any line has a problem.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
