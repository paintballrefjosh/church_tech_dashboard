"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, DoorOpen, LifeBuoy, Pencil, Printer } from "lucide-react";
import { PERMISSIONS, type AssetStatus, type Location, type LocationSummary } from "@church/shared";
import { StatusChip, can, useRooms, useViewer } from "@/components/assets-ui";
import { GoneNotice } from "@/components/gone-notice";
import { useToasts, ToastStack } from "../../monitoring/network-cisco/cisco-ui";
import { RoomFormModal } from "../room-form";

const btn = "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800";

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-md border border-slate-300 dark:border-slate-800">
      <h2 className="border-b border-slate-200 px-3 py-2 text-sm font-semibold dark:border-slate-800">
        {title} <span className="font-normal text-slate-500 dark:text-slate-400">({count})</span>
      </h2>
      {count === 0 ? <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">None here.</p> : <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">{children}</ul>}
    </section>
  );
}

function Row({ href, children, aside }: { href: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <Link href={href} className="min-w-0 flex-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
        {children}
      </Link>
      {aside ? <span className="text-xs text-slate-500 dark:text-slate-400">{aside}</span> : null}
    </li>
  );
}

/**
 * One room: what is there (each kind only for those who may see it) and the two things people come here for: report a
 * problem in this room, and print the room's sign.
 */
export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const me = useViewer();
  const [rooms] = useRooms();
  const [data, setData] = useState<LocationSummary | null>(null);
  const [gone, setGone] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const { toasts, show, dismiss } = useToasts();

  const load = useCallback(async () => {
    const r = await fetch(`/api/locations/${id}/summary`, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 404 || r.status === 400) return setGone(true);
    if (r.ok) setData((await r.json()) as LocationSummary);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (gone) return <GoneNotice what="room" backHref="/rooms" backLabel="Rooms" />;
  if (!data) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  const room = data.location;

  return (
    <div className="space-y-5">
      <Link href="/rooms" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Rooms
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {room.building ? <p className="text-sm text-slate-500 dark:text-slate-400">{room.building}</p> : null}
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <DoorOpen className="h-6 w-6 text-brand-600 dark:text-brand-400" aria-hidden />
            {room.name}
          </h1>
          {room.notes ? <p className="mt-1 max-w-2xl whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-400">{room.notes}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/tickets/new?room=${room.id}`} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <LifeBuoy className="h-4 w-4" aria-hidden /> Report a problem here
          </Link>
          <Link href={`/print/rooms/${room.id}`} className={btn}>
            <Printer className="h-4 w-4" aria-hidden /> Print sign
          </Link>
          {can(me, PERMISSIONS.LOCATIONS_ADMIN) ? (
            <button type="button" className={btn} onClick={() => setEditing(room)}>
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {data.tickets ? (
          <Section title="Open tickets" count={data.tickets.length}>
            {data.tickets.map((t) => (
              <Row key={t.id} href={`/tickets/${t.id}`} aside={t.status.replace("_", " ")}>
                #{t.number} {t.title}
              </Row>
            ))}
          </Section>
        ) : null}
        {data.assets ? (
          <Section title="Equipment kept here" count={data.assets.length}>
            {data.assets.map((a) => (
              <Row key={a.id} href={`/assets/${a.id}`} aside={a.holderName ? `with ${a.holderName}` : a.status !== "in_service" ? <StatusChip status={a.status as AssetStatus} /> : null}>
                <span className="font-mono text-xs">{a.tag}</span> {a.name}
              </Row>
            ))}
          </Section>
        ) : null}
        {data.racks ? (
          <Section title="Cabinets" count={data.racks.length}>
            {data.racks.map((r) => (
              <Row key={r.id} href={`/cabinets/${r.id}`}>
                {r.name}
              </Row>
            ))}
          </Section>
        ) : null}
        {data.hosts ? (
          <Section title="Hosts" count={data.hosts.length}>
            {data.hosts.map((h) => (
              <Row key={h.id} href={`/monitoring/infra/${h.id}`} aside={h.status}>
                {h.name}
              </Row>
            ))}
          </Section>
        ) : null}
        {data.monitors ? (
          <Section title="Monitors" count={data.monitors.length}>
            {data.monitors.map((m) => (
              <Row key={m.id} href={`/monitoring/${m.id}`} aside={m.status}>
                {m.name}
              </Row>
            ))}
          </Section>
        ) : null}
        {data.printers ? (
          <Section title="Printers" count={data.printers.length}>
            {data.printers.map((p) => (
              <Row key={p.id} href="/printers">
                {p.name}
              </Row>
            ))}
          </Section>
        ) : null}
      </div>

      {editing ? (
        <RoomFormModal
          room={editing}
          buildings={[...new Set((rooms ?? []).map((r) => r.building).filter(Boolean))]}
          onClose={() => setEditing(null)}
          onSaved={(r, how) => {
            setEditing(null);
            if (how === "deleted") router.push("/rooms");
            else {
              show(true, `Saved ${r.name}.`);
              void load();
            }
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
