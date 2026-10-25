import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { publicOrigin, qrSvg } from "@/lib/qr";
import type { Location } from "@church/shared";
import { PrintButton } from "../../vouchers/print-button";

export const dynamic = "force-dynamic";

/** A room's sign: its name and a QR code that opens "report a problem" with the room already filled in. One A5 half page. */
export default async function RoomSignPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  const [room, site, origin] = await Promise.all([
    apiJson<Location>(`/api/v1/locations/${encodeURIComponent(id)}`).catch(() => null),
    apiJson<{ siteName?: string }>("/api/v1/settings/public").catch(() => null),
    publicOrigin(),
  ]);
  if (!room) {
    return (
      <main className="p-6 text-sm">
        This room no longer exists. <a href="/rooms" className="underline">Rooms</a>
      </main>
    );
  }
  const url = `${origin}/tickets/new?room=${room.id}`;
  const code = await qrSvg(url);

  return (
    <main className="min-h-screen bg-slate-100 px-3 py-6 text-slate-900 print:bg-white print:p-0 dark:bg-slate-900 print:dark:bg-white">
      <div className="mx-auto mb-4 flex max-w-[148mm] items-center gap-3 print:hidden">
        <a href={`/rooms/${room.id}`} className="text-sm text-brand-600 underline dark:text-brand-400">
          Back to {room.name}
        </a>
        <span className="ml-auto">
          <PrintButton />
        </span>
      </div>
      <section className="mx-auto flex max-w-[148mm] flex-col items-center bg-white p-[12mm] text-center shadow print:shadow-none">
        {site?.siteName ? <p className="text-sm uppercase tracking-[0.2em] text-slate-600">{site.siteName}</p> : null}
        <h1 className="mt-[3mm] text-4xl font-bold">{room.name}</h1>
        {room.building ? <p className="text-lg text-slate-700">{room.building}</p> : null}
        <div className="my-[8mm] h-[70mm] w-[70mm] [&>svg]:h-full [&>svg]:w-full" data-testid="room-qr" aria-hidden dangerouslySetInnerHTML={{ __html: code }} />
        <p className="text-xl font-semibold">Something not working in here?</p>
        <p className="mt-[2mm] text-base text-slate-700">Scan the code to tell the tech team. The room is filled in for you.</p>
        <p className="mt-[5mm] break-all font-mono text-[10px] text-slate-500">{url}</p>
      </section>
    </main>
  );
}
