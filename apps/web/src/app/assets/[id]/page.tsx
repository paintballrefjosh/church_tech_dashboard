"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, LifeBuoy, LogIn, LogOut, Package, Pencil, Printer, Trash2 } from "lucide-react";
import { ASSET_CATEGORY_LABELS, PERMISSIONS, type Asset, type AssetCheckout } from "@church/shared";
import { HolderLine, RoomLink, StatusChip, can, localToday, sendJson, useRooms, useViewer } from "@/components/assets-ui";
import { GoneNotice } from "@/components/gone-notice";
import { Modal, Field, inputCls, cardCls, useToasts, ToastStack } from "../../monitoring/network-cisco/cisco-ui";
import { AssetFormModal } from "../asset-form";

interface TicketRow {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  updatedAt: string;
}

const btn = "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800";
const primary = "inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60";

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One item: who has it, check it out or back in, its details, what has been reported about it, and (staff) its history. */
export default function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const me = useViewer();
  const [rooms] = useRooms();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "forbidden">("loading");
  const [history, setHistory] = useState<AssetCheckout[] | null>(null);
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [lending, setLending] = useState<"me" | "other" | null>(null);
  const [dueEdit, setDueEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toasts, show, dismiss } = useToasts();
  const staff = can(me, PERMISSIONS.ASSETS_WRITE_ANY);
  const admin = can(me, PERMISSIONS.ASSETS_ADMIN);

  const load = useCallback(async () => {
    const r = await fetch(`/api/assets/${id}`, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 404 || r.status === 400) return setState("gone");
    if (r.status === 403) return setState("forbidden");
    if (!r.ok) return;
    setAsset((await r.json()) as Asset);
    setState("ok");
    fetch(`/api/assets/${id}/tickets`, { credentials: "same-origin", cache: "no-store" })
      .then((t) => (t.ok ? t.json() : []))
      .then((t: TicketRow[]) => setTickets(t))
      .catch(() => setTickets([]));
  }, [id]);

  const loadHistory = useCallback(async () => {
    const r = await fetch(`/api/assets/${id}/history`, { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setHistory((await r.json()) as AssetCheckout[]);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (staff) void loadHistory();
  }, [staff, loadHistory]);

  async function act(fn: () => Promise<Asset>, done: string) {
    setBusy(true);
    try {
      setAsset(await fn());
      show(true, done);
      if (staff) void loadHistory();
    } catch (err) {
      show(false, (err as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!asset || !confirm(`Delete ${asset.tag} ${asset.name}? Its check-out history goes with it. To keep the record, mark it Retired or Lost instead.`)) return;
    try {
      await sendJson(`/api/assets/${asset.id}`, "DELETE");
      router.push("/assets");
    } catch (err) {
      show(false, (err as Error).message);
    }
  }

  if (state === "gone") return <GoneNotice what="item" backHref="/assets" backLabel="Equipment" />;
  if (state === "forbidden") return <p className="text-sm text-slate-600 dark:text-slate-400">Your account does not have the Equipment module.</p>;
  if (!asset) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  const holder = asset.holder;
  const mine = holder?.userId === me?.id;
  const canTake = !holder && asset.lendable && asset.status === "in_service";
  const canReturn = !!holder && (mine || staff);

  return (
    <div className="space-y-5">
      <Link href="/assets" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Equipment
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm text-slate-500 dark:text-slate-400">{asset.tag}</p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Package className="h-6 w-6 text-brand-600 dark:text-brand-400" aria-hidden />
            {asset.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <StatusChip status={asset.status} />
            <span className="text-slate-600 dark:text-slate-400">{[ASSET_CATEGORY_LABELS[asset.category], asset.make, asset.model].filter(Boolean).join(" · ")}</span>
            <RoomLink room={asset.location} rooms={rooms} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/tickets/new?asset=${asset.id}`} className={btn}>
            <LifeBuoy className="h-4 w-4" aria-hidden /> Report a problem with this
          </Link>
          <Link href={`/print/assets?ids=${asset.id}`} className={btn}>
            <Printer className="h-4 w-4" aria-hidden /> Print label
          </Link>
          {staff ? (
            <button type="button" className={btn} onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </button>
          ) : null}
          {admin ? (
            <button type="button" className={`${btn} text-rose-700 dark:text-rose-300`} onClick={() => void remove()} aria-label={`Delete ${asset.tag}`}>
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          ) : null}
        </div>
      </header>

      <section className={`${cardCls} space-y-3`} aria-label="Where it is">
        <p className="text-base">
          <HolderLine asset={asset} />
          {holder ? <span className="text-sm text-slate-500 dark:text-slate-400"> · since {fmt(holder.outAt)}</span> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {canTake && can(me, PERMISSIONS.ASSETS_CHECKOUT_OWN) ? (
            <button type="button" className={primary} disabled={busy} onClick={() => setLending("me")}>
              <LogOut className="h-4 w-4" aria-hidden /> Check out to me
            </button>
          ) : null}
          {canTake && staff ? (
            <button type="button" className={btn} disabled={busy} onClick={() => setLending("other")}>
              Check out to someone else
            </button>
          ) : null}
          {canReturn ? (
            <button
              type="button"
              className={primary}
              disabled={busy}
              onClick={() => void act(() => sendJson<Asset>(`/api/assets/${asset.id}/return`, "POST", {}), `${asset.tag} is back.`)}
            >
              <LogIn className="h-4 w-4" aria-hidden /> {mine ? "I have returned it" : "Mark as returned"}
            </button>
          ) : null}
          {holder && staff ? (
            <button type="button" className={btn} disabled={busy} onClick={() => setDueEdit(true)}>
              Change due date
            </button>
          ) : null}
        </div>
        {!holder && !asset.lendable ? <p className="text-sm text-slate-500 dark:text-slate-400">This is installed kit, so it is not checked out.</p> : null}
        {!holder && asset.lendable && asset.status !== "in_service" ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">It cannot be checked out while it is {asset.status === "in_repair" ? "in repair" : asset.status}.</p>
        ) : null}
      </section>

      <section className={cardCls} aria-label="Details">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Detail label="Serial number" value={asset.serial} mono />
          <Detail label="Kept in" value={asset.location?.name ?? ""} />
          {staff ? (
            <>
              <Detail label="Bought on" value={asset.purchasedOn ?? ""} />
              <Detail label="Cost" value={asset.cost === null ? "" : asset.cost.toFixed(2)} />
            </>
          ) : null}
          <Detail label="Warranty until" value={asset.warrantyUntil ?? ""} />
        </dl>
        {asset.notes ? <p className="mt-3 whitespace-pre-wrap text-sm">{asset.notes}</p> : null}
      </section>

      <section aria-labelledby="tickets-h">
        <h2 id="tickets-h" className="mb-2 text-sm font-semibold">
          Reported problems
        </h2>
        {tickets === null ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        ) : tickets.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">None that you can see.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 text-sm dark:divide-slate-800 dark:border-slate-800">
            {tickets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Link href={`/tickets/${t.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                  #{t.number} {t.title}
                </Link>
                <span className="text-xs text-slate-500 dark:text-slate-400">{t.status.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {staff ? (
        <section aria-labelledby="history-h">
          <h2 id="history-h" className="mb-2 text-sm font-semibold">
            Who has had it
          </h2>
          {history === null ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Never checked out.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Check-out history">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Who</th>
                    <th className="px-3 py-2">Out</th>
                    <th className="px-3 py-2">Due</th>
                    <th className="px-3 py-2">Back</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{h.holderName}</div>
                        {h.outByName && h.outByName !== h.holderName ? <div className="text-xs text-slate-500 dark:text-slate-400">lent by {h.outByName}</div> : null}
                        {h.note ? <div className="text-xs text-slate-500 dark:text-slate-400">{h.note}</div> : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{fmt(h.outAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{h.dueOn ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {h.returnedAt ? fmt(h.returnedAt) : <span className="font-medium">Still out</span>}
                        {h.returnNote ? <div className="text-xs text-slate-500 dark:text-slate-400">{h.returnNote}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {editing ? (
        <AssetFormModal
          asset={asset}
          rooms={rooms}
          onClose={() => setEditing(false)}
          onSaved={(a) => {
            setEditing(false);
            setAsset(a);
            show(true, "Saved.");
          }}
        />
      ) : null}
      {lending ? (
        <CheckoutModal
          forOther={lending === "other"}
          onClose={() => setLending(null)}
          onSubmit={(body) => {
            setLending(null);
            void act(() => sendJson<Asset>(`/api/assets/${asset.id}/checkout`, "POST", body), `${asset.tag} checked out.`);
          }}
        />
      ) : null}
      {dueEdit && holder ? (
        <DueModal
          current={holder.dueOn}
          onClose={() => setDueEdit(false)}
          onSubmit={(dueOn) => {
            setDueEdit(false);
            void act(() => sendJson<Asset>(`/api/assets/${asset.id}/due`, "PUT", { dueOn }), dueOn ? `Due back ${dueOn}.` : "No due date.");
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={mono ? "font-mono" : undefined}>{value || <span className="text-slate-500 dark:text-slate-400">—</span>}</dd>
    </div>
  );
}

interface PersonOption {
  id: string;
  name: string;
}

/** Check out: a due date and a note; for staff, also who to (an account, when the user list can be read, or a typed name). */
function CheckoutModal({
  forOther,
  onClose,
  onSubmit,
}: {
  forOther: boolean;
  onClose: () => void;
  onSubmit: (body: { holderUserId?: string; holderName?: string; dueOn: string | null; note: string }) => void;
}) {
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const [people, setPeople] = useState<PersonOption[] | null>(null);
  const [personId, setPersonId] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    if (!forOther) return;
    fetch("/api/users", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: string; name: string | null; email: string; isActive?: boolean; deletedAt?: string | null }>) =>
        setPeople(
          list
            .filter((u) => u.isActive !== false && !u.deletedAt)
            .map((u) => ({ id: u.id, name: u.name ?? u.email }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      )
      .catch(() => setPeople([]));
  }, [forOther]);
  const ready = !forOther || !!personId || !!name.trim();
  return (
    <Modal title={forOther ? "Check out to someone else" : "Check out to me"} onClose={onClose}>
      <div className="space-y-3">
        {forOther ? (
          <>
            {people && people.length > 0 ? (
              <Field label="A person with an account">
                <select
                  className={`${inputCls} w-full`}
                  value={personId}
                  onChange={(e) => {
                    setPersonId(e.target.value);
                    if (e.target.value) setName("");
                  }}
                >
                  <option value="">Choose…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label={people && people.length > 0 ? "Or type a name (someone without an account)" : "Their name"}>
              <input
                className={`${inputCls} w-full`}
                value={name}
                maxLength={120}
                onChange={(e) => {
                  setName(e.target.value);
                  if (e.target.value) setPersonId("");
                }}
              />
            </Field>
          </>
        ) : null}
        <Field label="Due back (optional)">
          <input type="date" min={localToday()} className={`${inputCls} w-full`} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <input className={`${inputCls} w-full`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="For the youth weekend" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            className={primary}
            onClick={() =>
              onSubmit({
                ...(personId ? { holderUserId: personId } : {}),
                ...(name.trim() ? { holderName: name.trim() } : {}),
                dueOn: dueOn || null,
                note,
              })
            }
          >
            Check out
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DueModal({ current, onClose, onSubmit }: { current: string | null; onClose: () => void; onSubmit: (dueOn: string | null) => void }) {
  const [dueOn, setDueOn] = useState(current ?? "");
  return (
    <Modal title="Change due date" onClose={onClose}>
      <Field label="Due back (empty = no date)">
        <input type="date" className={`${inputCls} w-full`} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 pt-4">
        <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          Cancel
        </button>
        <button type="button" className={primary} onClick={() => onSubmit(dueOn || null)}>
          Save
        </button>
      </div>
    </Modal>
  );
}
