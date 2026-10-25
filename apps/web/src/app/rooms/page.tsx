"use client";

import { useState } from "react";
import Link from "next/link";
import { DoorOpen, Pencil, Plus } from "lucide-react";
import { PERMISSIONS, groupLocations, type Location } from "@church/shared";
import { PageTitle } from "@/components/page-title";
import { can, useRooms, useViewer } from "@/components/assets-ui";
import { useToasts, ToastStack } from "../monitoring/network-cisco/cisco-ui";
import { RoomFormModal } from "./room-form";

/** Every room, by building. Each opens its page (what is there, report a problem there, print its sign). */
export default function RoomsPage() {
  const me = useViewer();
  const [rooms, reload] = useRooms();
  const [form, setForm] = useState<Location | "new" | null>(null);
  const { toasts, show, dismiss } = useToasts();
  const admin = can(me, PERMISSIONS.LOCATIONS_ADMIN);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle icon={DoorOpen}>Rooms</PageTitle>
        {admin ? (
          <button
            type="button"
            onClick={() => setForm("new")}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add a room
          </button>
        ) : null}
      </div>
      <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        One list of places, used by tickets, equipment, cabinets, monitors, hosts and printers. A room&apos;s page shows what is there and has
        a sign to print with a code that opens &quot;report a problem here&quot;.
      </p>

      {rooms === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="rounded-md border border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-400">
          No rooms yet.{admin ? " Add the places your equipment lives and things go wrong." : ""}
        </p>
      ) : (
        <div className="space-y-5">
          {groupLocations(rooms).map((g) => (
            <section key={g.building || "-"} aria-label={g.building || "Rooms"}>
              {g.building ? <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{g.building}</h2> : null}
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {g.rooms.map((r) => (
                  <li key={r.id} className="flex items-start gap-2 rounded-md border border-slate-300 p-3 dark:border-slate-800">
                    <Link href={`/rooms/${r.id}`} className="min-w-0 flex-1">
                      <span className="block font-medium hover:underline">{r.name}</span>
                      {r.notes ? <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{r.notes}</span> : null}
                    </Link>
                    {admin ? (
                      <button
                        type="button"
                        onClick={() => setForm(r)}
                        className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                        aria-label={`Edit ${r.name}`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {form ? (
        <RoomFormModal
          room={form === "new" ? null : form}
          buildings={[...new Set((rooms ?? []).map((r) => r.building).filter(Boolean))]}
          onClose={() => setForm(null)}
          onSaved={(r, how) => {
            setForm(null);
            show(true, how === "deleted" ? `Removed ${r.name}.` : `Saved ${r.name}.`);
            void reload();
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
