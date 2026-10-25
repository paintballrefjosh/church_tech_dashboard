"use client";

import { useState } from "react";
import { ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, ASSET_STATUSES, ASSET_STATUS_LABELS, type Asset, type AssetCategory, type AssetStatus, type Location } from "@church/shared";
import { Modal, Field, inputCls } from "../monitoring/network-cisco/cisco-ui";
import { RoomField, sendJson } from "@/components/assets-ui";

interface FormState {
  tag: string;
  name: string;
  category: AssetCategory;
  make: string;
  model: string;
  serial: string;
  locationId: string | null;
  status: AssetStatus;
  lendable: boolean;
  purchasedOn: string;
  cost: string;
  warrantyUntil: string;
  notes: string;
}

function fromAsset(a: Asset | null): FormState {
  return {
    tag: a?.tag ?? "",
    name: a?.name ?? "",
    category: a?.category ?? "other",
    make: a?.make ?? "",
    model: a?.model ?? "",
    serial: a?.serial ?? "",
    locationId: a?.location?.id ?? null,
    status: a?.status ?? "in_service",
    lendable: a?.lendable ?? true,
    purchasedOn: a?.purchasedOn ?? "",
    cost: a?.cost === null || a?.cost === undefined ? "" : String(a.cost),
    warrantyUntil: a?.warrantyUntil ?? "",
    notes: a?.notes ?? "",
  };
}

/** Add an item (`asset` null) or edit one. Staff only; the API checks. Calls `onSaved` with what the API returned. */
export function AssetFormModal({
  asset,
  rooms,
  onClose,
  onSaved,
}: {
  asset: Asset | null;
  rooms: Location[] | null;
  onClose: () => void;
  onSaved: (a: Asset) => void;
}) {
  const [f, setF] = useState<FormState>(() => fromAsset(asset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const cost = f.cost.trim() === "" ? null : Number(f.cost.replace(/[^0-9.]/g, ""));
      if (cost !== null && !Number.isFinite(cost)) throw new Error("The cost is not a number.");
      const body = {
        ...(asset ? (f.tag.trim() && f.tag.trim() !== asset.tag ? { tag: f.tag.trim() } : {}) : { tag: f.tag.trim() }),
        name: f.name,
        category: f.category,
        make: f.make,
        model: f.model,
        serial: f.serial,
        locationId: f.locationId,
        status: f.status,
        lendable: f.lendable,
        purchasedOn: f.purchasedOn || null,
        cost,
        warrantyUntil: f.warrantyUntil || null,
        notes: f.notes,
      };
      const saved = await sendJson<Asset>(asset ? `/api/assets/${asset.id}` : "/api/assets", asset ? "PATCH" : "POST", body);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={asset ? `Edit ${asset.tag}` : "Add an item"} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label="Name">
            <input className={`${inputCls} w-full`} value={f.name} maxLength={200} onChange={(e) => set("name", e.target.value)} placeholder="Wireless handheld mic" autoFocus />
          </Field>
          <Field label="Tag">
            <input className={`${inputCls} w-full font-mono`} value={f.tag} maxLength={40} onChange={(e) => set("tag", e.target.value)} placeholder={asset ? "" : "Next number"} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Category">
            <select className={`${inputCls} w-full`} value={f.category} onChange={(e) => set("category", e.target.value as AssetCategory)}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ASSET_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Make">
            <input className={`${inputCls} w-full`} value={f.make} maxLength={120} onChange={(e) => set("make", e.target.value)} placeholder="Shure" />
          </Field>
          <Field label="Model">
            <input className={`${inputCls} w-full`} value={f.model} maxLength={120} onChange={(e) => set("model", e.target.value)} placeholder="SLXD24/SM58" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Serial number">
            <input className={`${inputCls} w-full font-mono`} value={f.serial} maxLength={120} onChange={(e) => set("serial", e.target.value)} />
          </Field>
          <RoomField value={f.locationId} onChange={(v) => set("locationId", v)} rooms={rooms} label="Kept in" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status">
            <select className={`${inputCls} w-full`} value={f.status} onChange={(e) => set("status", e.target.value as AssetStatus)}>
              {ASSET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ASSET_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={f.lendable} onChange={(e) => set("lendable", e.target.checked)} />
            Can be checked out (untick for installed kit)
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Bought on">
            <input type="date" className={`${inputCls} w-full`} value={f.purchasedOn} onChange={(e) => set("purchasedOn", e.target.value)} />
          </Field>
          <Field label="Cost">
            <input inputMode="decimal" className={`${inputCls} w-full`} value={f.cost} onChange={(e) => set("cost", e.target.value)} />
          </Field>
          <Field label="Warranty until">
            <input type="date" className={`${inputCls} w-full`} value={f.warrantyUntil} onChange={(e) => set("warrantyUntil", e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={`${inputCls} w-full`} rows={3} maxLength={4000} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Which case it lives in, the battery type, who to ask" />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-4">
        <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !f.name.trim()}
          onClick={() => void save()}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? "Saving…" : asset ? "Save" : "Add"}
        </button>
      </div>
    </Modal>
  );
}
