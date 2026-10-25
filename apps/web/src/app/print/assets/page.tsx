import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { publicOrigin, qrSvg } from "@/lib/qr";
import type { Asset } from "@church/shared";
import { PrintButton } from "../vouchers/print-button";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Equipment labels, 24 to an A4 page (3 x 8), for label sheets or cutting out. Each carries a QR code that opens the item's
 * page, where it is checked out or back in. `?ids=` names the items; what is printed is read from the API.
 */
export default async function AssetLabelsPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { ids = "" } = await searchParams;
  const wanted = ids.split(",").filter((x) => UUID.test(x)).slice(0, 500);
  const [all, site, origin] = await Promise.all([
    apiJson<Asset[]>("/api/v1/assets").catch(() => null),
    apiJson<{ siteName?: string }>("/api/v1/settings/public").catch(() => null),
    publicOrigin(),
  ]);
  const byId = new Map((all ?? []).map((a) => [a.id, a]));
  const items = wanted.map((id) => byId.get(id)).filter((a): a is Asset => !!a);
  const codes = await Promise.all(items.map((a) => qrSvg(`${origin}/assets/${a.id}`)));
  const owner = site?.siteName?.trim() || "";

  return (
    <main className="min-h-screen bg-slate-100 px-3 py-6 text-slate-900 print:bg-white print:p-0 dark:bg-slate-900 print:dark:bg-white">
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center gap-3 print:hidden">
        <a href="/assets" className="text-sm text-brand-600 underline dark:text-brand-400">
          Back to Equipment
        </a>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {all === null ? "The equipment could not be read." : `${items.length} label${items.length === 1 ? "" : "s"}.`}
        </p>
        <span className="ml-auto">
          <PrintButton />
        </span>
      </div>
      <div className="mx-auto grid max-w-[210mm] grid-cols-3 gap-[2mm] bg-white p-[6mm] shadow print:max-w-none print:p-0 print:shadow-none">
        {items.map((a, i) => (
          <section key={a.id} data-testid="asset-label" className="flex h-[33mm] break-inside-avoid items-center gap-[2.5mm] overflow-hidden rounded border border-dashed border-slate-400 p-[2.5mm]">
            <div className="h-[26mm] w-[26mm] shrink-0 [&>svg]:h-full [&>svg]:w-full" aria-hidden dangerouslySetInnerHTML={{ __html: codes[i]! }} />
            <div className="min-w-0">
              <p className="font-mono text-lg font-bold leading-tight">{a.tag}</p>
              <p className="line-clamp-2 text-xs leading-snug">{a.name}</p>
              {owner ? <p className="mt-[1mm] truncate text-[9px] text-slate-600">Property of {owner}</p> : null}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
