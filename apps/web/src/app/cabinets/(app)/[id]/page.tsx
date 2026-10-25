"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import {
  MAX_RACK_UNITS,
  RACK_ITEM_STYLES,
  RACK_ITEM_STYLE_LABELS,
  defaultRackStyle,
  firstFreeSlot,
  placementProblem,
  suggestHeightU,
  topU,
  usedUnits,
  type RackCandidate,
  type RackDetail,
  type RackItemStyle,
  type RackItemView,
  type RackSourceKind,
} from "@church/shared";
import { useCanWrite, StatusLine, inputCls, cardCls, Modal, Field } from "@/app/monitoring/network-cisco/cisco-ui";
import { RackElevation } from "@/components/rack-elevation";
import { errorText, useSwitchModels } from "@/lib/use-switch-models";
import { matchSwitchModel } from "@/lib/faceplates/custom";
import { modelPicture, type RackSide } from "@/lib/rack-pictures";

type Dialog =
  | { kind: "add"; startU: number | null }
  | { kind: "edit"; item: RackItemView }
  | { kind: "cabinet" }
  | { kind: "delete" }
  | null;

const SOURCE_LABELS: Record<RackSourceKind, string> = {
  cisco: "Cisco switch",
  infra: "Infrastructure host",
  unifi: "UniFi device",
  custom: "Custom item",
};

const BASE = "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs";
const ON = "bg-brand-600 text-white";
const OFF = "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800";

function SideToggle({ value, onChange }: { value: RackSide; onChange: (v: RackSide) => void }) {
  return (
    <div role="group" aria-label="Show the cabinet from" className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
      <button type="button" aria-pressed={value === "front"} onClick={() => onChange("front")} className={`${BASE} ${value === "front" ? ON : OFF}`}>
        Front
      </button>
      <button type="button" aria-pressed={value === "rear"} onClick={() => onChange("rear")} className={`${BASE} border-l border-slate-300 dark:border-slate-700 ${value === "rear" ? ON : OFF}`}>
        Rear
      </button>
    </div>
  );
}

const STATUS_TEXT: Record<RackItemView["live"]["status"], string> = { up: "Up", down: "Down", unknown: "-" };
const STATUS_CLS: Record<RackItemView["live"]["status"], string> = {
  up: "text-emerald-700 dark:text-emerald-400",
  down: "text-rose-700 dark:text-rose-400",
  unknown: "text-slate-500 dark:text-slate-400",
};

export default function CabinetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const canWrite = useCanWrite();
  const { models } = useSwitchModels();
  const [rack, setRack] = useState<RackDetail | null>(null);
  const [side, setSide] = useState<RackSide>("front");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/racks/${id}`, { credentials: "same-origin", cache: "no-store" });
      if (r.status === 404) return setNotFound(true);
      if (r.ok) setRack((await r.json()) as RackDetail);
      else setStatus({ ok: false, text: await errorText(r) });
    } catch {
      setStatus({ ok: false, text: "The cabinet could not be loaded." });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => [...(rack?.items ?? [])].sort((a, b) => topU(b) - topU(a)), [rack]);

  if (notFound) {
    return (
      <div className="space-y-3">
        <Link href="/cabinets" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All cabinets
        </Link>
        <p className="text-sm">That cabinet does not exist.</p>
      </div>
    );
  }
  if (!rack) {
    return (
      <div className="space-y-3">
        <StatusLine status={status} />
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </div>
    );
  }

  const free = rack.units - usedUnits(items);

  return (
    <div className="space-y-4">
      <Link href="/cabinets" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All cabinets
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{rack.name}</h2>
        {rack.location ? <span className="text-sm text-slate-500 dark:text-slate-400">{rack.location}</span> : null}
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {rack.units}U · {usedUnits(items)}U used · {Math.max(free, 0)}U free
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SideToggle value={side} onChange={setSide} />
          <Link
            href={`/cabinets/${rack.id}/print`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <Printer className="h-4 w-4" aria-hidden /> Printable page
          </Link>
          {canWrite ? (
            <>
              <button
                type="button"
                onClick={() => setDialog({ kind: "cabinet" })}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Pencil className="h-4 w-4" aria-hidden /> Edit cabinet
              </button>
              <button
                type="button"
                onClick={() => setDialog({ kind: "add", startU: null })}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                <Plus className="h-4 w-4" aria-hidden /> Add item
              </button>
            </>
          ) : null}
        </div>
      </div>
      <StatusLine status={status} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="overflow-x-auto" style={{ ["--u" as string]: "1.7rem" }}>
          <RackElevation
            units={rack.units}
            items={rack.items}
            models={models ?? []}
            side={side}
            variant="screen"
            label={`${rack.name}, ${side} view, ${rack.units}U`}
            selectedId={dialog?.kind === "edit" ? dialog.item.id : null}
            onSelect={canWrite ? (item) => setDialog({ kind: "edit", item }) : undefined}
            onEmpty={canWrite ? (u) => setDialog({ kind: "add", startU: u }) : undefined}
          />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {canWrite ? "Click an empty slot to place something there, or an item to change it. " : ""}
            U1 is the bottom. Pictures come from the switch models; an item with none is drawn as a plain face.
          </p>
        </div>

        <div className="min-w-0">
          <div tabIndex={0} role="region" aria-label="Items in this cabinet" className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  <th scope="col" className="py-1.5 pr-3 font-medium">U</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Hostname</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">IP</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Status</th>
                  {canWrite ? (
                    <th scope="col" className="py-1.5 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={canWrite ? 6 : 5} className="py-4 text-sm text-slate-600 dark:text-slate-300">
                      Nothing placed yet.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => (
                    <tr key={it.id} className="border-b border-slate-200 align-top dark:border-slate-800">
                      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">{it.heightU > 1 ? `${it.startU}-${topU(it)}` : it.startU}</td>
                      <td className="py-1.5 pr-3">
                        {it.live.href ? (
                          <Link href={it.live.href} className="text-brand-600 hover:underline dark:text-brand-400">
                            {it.live.name}
                          </Link>
                        ) : (
                          it.live.name
                        )}
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {it.live.missing ? "Not found in its system any more" : it.sourceKind === "custom" ? RACK_ITEM_STYLE_LABELS[it.style] : SOURCE_LABELS[it.sourceKind]}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{it.live.hostname ?? "-"}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{it.live.ip ?? "-"}</td>
                      <td className={`py-1.5 pr-3 text-xs ${STATUS_CLS[it.live.status]}`}>{STATUS_TEXT[it.live.status]}</td>
                      {canWrite ? (
                        <td className="py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: "edit", item: it })}
                            aria-label={`Edit ${it.live.name}`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {rack.notes ? <p className={`${cardCls} mt-4 whitespace-pre-wrap text-sm`}>{rack.notes}</p> : null}
        </div>
      </div>

      {dialog?.kind === "add" ? (
        <ItemDialog
          rack={rack}
          item={null}
          startU={dialog.startU}
          onClose={() => setDialog(null)}
          onDone={async (text) => {
            setDialog(null);
            setStatus({ ok: true, text });
            await load();
          }}
        />
      ) : null}
      {dialog?.kind === "edit" ? (
        <ItemDialog
          rack={rack}
          item={dialog.item}
          startU={null}
          onClose={() => setDialog(null)}
          onDone={async (text) => {
            setDialog(null);
            setStatus({ ok: true, text });
            await load();
          }}
        />
      ) : null}
      {dialog?.kind === "cabinet" ? (
        <CabinetDialog
          rack={rack}
          onClose={() => setDialog(null)}
          onDelete={() => setDialog({ kind: "delete" })}
          onDone={async () => {
            setDialog(null);
            setStatus({ ok: true, text: "Cabinet saved." });
            await load();
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteCabinetDialog
          rack={rack}
          onClose={() => setDialog(null)}
          onDone={() => {
            router.push("/cabinets");
          }}
        />
      ) : null}
    </div>
  );
}

// ---- item dialog ----

function ItemDialog({
  rack,
  item,
  startU,
  onClose,
  onDone,
}: {
  rack: RackDetail;
  item: RackItemView | null;
  startU: number | null;
  onClose: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const { models } = useSwitchModels();
  const editing = item !== null;
  const [kind, setKind] = useState<RackSourceKind>(item?.sourceKind ?? "cisco");
  const [candidates, setCandidates] = useState<RackCandidate[] | null>(null);
  const [sourceId, setSourceId] = useState(item?.sourceId ?? "");
  const [label, setLabel] = useState(item?.label ?? "");
  const [hostname, setHostname] = useState(item?.hostname ?? "");
  const [ip, setIp] = useState(item?.ip ?? "");
  const [style, setStyle] = useState<RackItemStyle>(item?.style ?? "switch");
  const [start, setStart] = useState(String(item?.startU ?? startU ?? firstFreeSlot(rack.units, rack.items, 1) ?? 1));
  const [height, setHeight] = useState(String(item?.heightU ?? 1));
  const [heightTouched, setHeightTouched] = useState(editing);
  const [modelId, setModelId] = useState(item?.modelId ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    fetch("/api/racks/candidates", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<RackCandidate[]>) : []))
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editing]);

  const choices = (candidates ?? []).filter((c) => c.kind === kind);
  const chosen = choices.find((c) => c.id === sourceId) ?? null;
  const modelList = (models ?? []).filter((m) => m.kind !== "module");

  // The picture the item would get, to suggest a height from its proportions.
  const suggestion = useMemo(() => {
    const model = modelId ? modelList.find((m) => m.id === modelId) ?? null : matchSwitchModel(models ?? [], chosen?.model ?? item?.live.model ?? null);
    const pic = modelPicture(model, "front");
    return pic ? { u: suggestHeightU(pic.width, pic.height, rack.units), name: pic.modelName } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, chosen, models, item, rack.units]);

  useEffect(() => {
    if (!heightTouched && suggestion) setHeight(String(suggestion.u));
  }, [suggestion, heightTouched]);

  const startN = Number(start);
  const heightN = Number(height);
  const place = { startU: startN, heightU: heightN };
  const problem =
    Number.isInteger(startN) && Number.isInteger(heightN) ? placementProblem(rack.units, rack.items, place, item?.id) : "Enter whole numbers for the position and height.";
  const missingDevice = !editing && kind !== "custom" && !sourceId;
  const missingName = (kind === "custom" || (editing && item?.sourceKind === "custom")) && !label.trim();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (problem || missingDevice || missingName) return;
    setBusy(true);
    setError(null);
    try {
      const custom = (editing ? item?.sourceKind : kind) === "custom";
      const body: Record<string, unknown> = {
        startU: startN,
        heightU: heightN,
        style,
        modelId: modelId || null,
        notes,
        ...(custom ? { label: label.trim(), hostname: hostname.trim() || null, ip: ip.trim() || null } : {}),
        ...(editing ? {} : { sourceKind: kind, sourceId: custom ? null : sourceId, ...(chosen ? { label: chosen.name } : {}) }),
      };
      const r = await fetch(editing ? `/api/racks/${rack.id}/items/${item.id}` : `/api/racks/${rack.id}/items`, {
        method: editing ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      await onDone(editing ? "Item saved." : "Item placed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/racks/${rack.id}/items/${item.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      await onDone(`${item.live.name} was taken out of the cabinet. The device itself is unchanged.`);
    } finally {
      setBusy(false);
    }
  }

  async function nudge(by: number) {
    if (!item) return;
    const to = item.startU + by;
    const why = placementProblem(rack.units, rack.items, { startU: to, heightU: item.heightU }, item.id);
    if (why) {
      setError(why);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/racks/${rack.id}/items/${item.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startU: to }),
      });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      await onDone(`${item.live.name} moved to U${to}.`);
    } finally {
      setBusy(false);
    }
  }

  const isCustom = (editing ? item?.sourceKind : kind) === "custom";

  return (
    <Modal title={editing ? `Edit ${item.live.name}` : "Place an item"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3 text-sm">
        {!editing ? (
          <>
            <fieldset>
              <legend className="text-xs text-slate-500 dark:text-slate-400">What is it?</legend>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {(Object.keys(SOURCE_LABELS) as RackSourceKind[]).map((k) => (
                  <label key={k} className="inline-flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === k}
                      onChange={() => {
                        setKind(k);
                        setSourceId("");
                        setStyle(defaultRackStyle(k));
                      }}
                    />
                    {SOURCE_LABELS[k]}
                  </label>
                ))}
              </div>
            </fieldset>
            {kind !== "custom" ? (
              <Field label="Device *">
                <select
                  value={sourceId}
                  onChange={(e) => {
                    const c = choices.find((x) => x.id === e.target.value);
                    setSourceId(e.target.value);
                    if (c) setStyle(c.style);
                  }}
                  className={`w-full ${inputCls}`}
                >
                  <option value="">{candidates === null ? "Loading…" : choices.length === 0 ? `No ${SOURCE_LABELS[kind].toLowerCase()}s found` : "Pick a device"}</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.placedIn !== null}>
                      {c.name}
                      {c.ip ? ` (${c.ip})` : ""}
                      {c.placedIn ? ` - already in ${c.placedIn.rackName}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {item.sourceKind === "custom" ? "A custom item." : `${SOURCE_LABELS[item.sourceKind]}: its name and address come from the device.`}
          </p>
        )}

        {isCustom ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name *">
              <input required maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Patch panel A" className={`w-full ${inputCls}`} />
            </Field>
            <Field label="Hostname">
              <input maxLength={120} value={hostname} onChange={(e) => setHostname(e.target.value)} className={`w-full font-mono text-xs ${inputCls}`} />
            </Field>
            <Field label="IP address">
              <input maxLength={64} value={ip} onChange={(e) => setIp(e.target.value)} className={`w-full font-mono text-xs ${inputCls}`} />
            </Field>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Lowest U (1-${rack.units})`}>
            <input type="number" min={1} max={rack.units} required value={start} onChange={(e) => setStart(e.target.value)} className={`w-full ${inputCls}`} />
          </Field>
          <Field label="Height (U)">
            <input
              type="number"
              min={1}
              max={MAX_RACK_UNITS}
              required
              value={height}
              onChange={(e) => {
                setHeight(e.target.value);
                setHeightTouched(true);
              }}
              className={`w-full ${inputCls}`}
            />
          </Field>
          <Field label="Drawn as (no picture)">
            <select value={style} onChange={(e) => setStyle(e.target.value as RackItemStyle)} className={`w-full ${inputCls}`}>
              {RACK_ITEM_STYLES.map((s) => (
                <option key={s} value={s}>
                  {RACK_ITEM_STYLE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {problem ? <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{problem}</p> : null}
        {suggestion && !heightTouched ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">Height taken from the {suggestion.name} picture ({suggestion.u}U). Change it if that is wrong.</p>
        ) : null}

        <Field label="Pictures">
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} className={`w-full ${inputCls}`}>
            <option value="">Automatic (the device&apos;s own switch model, if it has one)</option>
            {modelList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="-mt-2 text-xs text-slate-500 dark:text-slate-400">
          Front and rear pictures come from <Link href="/monitoring/network-cisco/models" className="text-brand-600 hover:underline dark:text-brand-400">Switch models</Link>. Any model can be used for any item.
        </p>

        <Field label="Notes">
          <textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className={`w-full ${inputCls}`} />
        </Field>

        {error ? <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">{error}</p> : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {editing ? (
            <>
              <button type="button" disabled={busy} onClick={() => void nudge(1)} aria-label="Move up one U" className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
                <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Up
              </button>
              <button type="button" disabled={busy} onClick={() => void nudge(-1)} aria-label="Move down one U" className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
                <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Down
              </button>
              <button type="button" disabled={busy} onClick={() => void remove()} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30">
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Take out of cabinet
              </button>
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
            <button type="submit" disabled={busy || !!problem || missingDevice || missingName} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
              {editing ? "Save" : "Place"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---- cabinet dialogs ----

function CabinetDialog({ rack, onClose, onDelete, onDone }: { rack: RackDetail; onClose: () => void; onDelete: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(rack.name);
  const [location, setLocation] = useState(rack.location);
  const [units, setUnits] = useState(String(rack.units));
  const [notes, setNotes] = useState(rack.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const highest = Math.max(0, ...rack.items.map(topU));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/racks/${rack.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, location, units: Number(units), notes }),
      });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit cabinet" onClose={onClose}>
      <form onSubmit={save} className="space-y-3 text-sm">
        <Field label="Name *">
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={`w-full ${inputCls}`} />
        </Field>
        <Field label="Location">
          <input maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} className={`w-full ${inputCls}`} />
        </Field>
        <Field label={`Height (U)${highest > 0 ? `, at least ${highest} (the highest item)` : ""}`}>
          <input type="number" min={Math.max(1, highest)} max={MAX_RACK_UNITS} required value={units} onChange={(e) => setUnits(e.target.value)} className={`w-28 ${inputCls}`} />
        </Field>
        <Field label="Notes">
          <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className={`w-full ${inputCls}`} />
        </Field>
        {error ? <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={onDelete} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs text-rose-700 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30">
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete cabinet
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function DeleteCabinetDialog({ rack, onClose, onDone }: { rack: RackDetail; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function doDelete() {
    setBusy(true);
    try {
      const r = await fetch(`/api/racks/${rack.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) {
        setError(await errorText(r));
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Delete cabinet" onClose={onClose}>
      <p className="text-sm">
        Delete <span className="font-semibold">{rack.name}</span> and its {rack.items.length} placed {rack.items.length === 1 ? "item" : "items"}? The devices themselves are not touched; only this record of where they sit goes.
      </p>
      {error ? <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void doDelete()} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60">
          Delete
        </button>
      </div>
    </Modal>
  );
}
