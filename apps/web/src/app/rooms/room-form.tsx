"use client";

import { useEffect, useId, useState } from "react";
import type { Location, LocationUsage } from "@church/shared";
import { Modal, Field, inputCls } from "../monitoring/network-cisco/cisco-ui";
import { sendJson } from "@/components/assets-ui";

const USAGE_WORDS: Array<[keyof LocationUsage, string, string]> = [
  ["tickets", "ticket", "tickets"],
  ["assets", "item of equipment", "items of equipment"],
  ["racks", "cabinet", "cabinets"],
  ["monitors", "monitor", "monitors"],
  ["hosts", "host", "hosts"],
  ["printers", "printer", "printers"],
];

function usageText(u: LocationUsage): string {
  const parts = USAGE_WORDS.filter(([k]) => u[k] > 0).map(([k, one, many]) => `${u[k]} ${u[k] === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : "nothing";
}

/** Add, rename or remove a room (`locations:admin`). Removing says first what it is cleared from. */
export function RoomFormModal({
  room,
  buildings,
  onClose,
  onSaved,
}: {
  room: Location | null;
  buildings: string[];
  onClose: () => void;
  onSaved: (r: Location, how: "saved" | "deleted") => void;
}) {
  const [name, setName] = useState(room?.name ?? "");
  const [building, setBuilding] = useState(room?.building ?? "");
  const [notes, setNotes] = useState(room?.notes ?? "");
  const [usage, setUsage] = useState<LocationUsage | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!room) return;
    fetch(`/api/locations/${room.id}/usage`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: LocationUsage | null) => setUsage(u))
      .catch(() => undefined);
  }, [room]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name, building, notes };
      const saved = await sendJson<Location>(room ? `/api/locations/${room.id}` : "/api/locations", room ? "PATCH" : "POST", body);
      onSaved(saved, "saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!room) return;
    setBusy(true);
    try {
      await sendJson(`/api/locations/${room.id}`, "DELETE");
      onSaved(room, "deleted");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={room ? `Edit ${room.name}` : "Add a room"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input className={`${inputCls} w-full`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Sound booth" autoFocus />
        </Field>
        <Field label="Building (optional, groups the list)">
          <input className={`${inputCls} w-full`} value={building} maxLength={120} list={listId} onChange={(e) => setBuilding(e.target.value)} placeholder="Main building" />
          <datalist id={listId}>
            {buildings.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </Field>
        <Field label="Notes">
          <textarea className={`${inputCls} w-full`} rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Key code, who looks after it" />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {error}
          </p>
        ) : null}
        {confirming && room ? (
          <div role="alert" className="rounded-md border border-rose-300 p-3 text-sm dark:border-rose-800">
            <p>
              Remove {room.name}? It is cleared from {usage ? usageText(usage) : "everything that names it"}; nothing else is deleted.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                Keep it
              </button>
              <button type="button" disabled={busy} onClick={() => void remove()} className="rounded-md bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800 disabled:opacity-60">
                Remove
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-2 pt-2">
          {room && !confirming ? (
            <button type="button" onClick={() => setConfirming(true)} className="rounded-md px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950">
              Remove room
            </button>
          ) : null}
          <span className="ml-auto" />
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void save()}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
