import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { describeVoucherMinutes, type UnifiVoucher } from "@church/shared";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

/**
 * Guest Wi-Fi voucher cards, eight to an A4 page, for cutting out. No navigation and white in dark mode: it is for paper.
 * `?ids=` names the vouchers; the codes are read from the API, never from the address.
 */
export default async function VoucherPrintPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { ids = "" } = await searchParams;
  const wanted = new Set(ids.split(",").filter((x) => /^[0-9a-f]{24}$/i.test(x)));
  const [all, ssid, site] = await Promise.all([
    apiJson<UnifiVoucher[]>("/api/v1/unifi/vouchers").catch(() => null),
    apiJson<{ value: unknown }>("/api/v1/settings/unifi.guest_ssid").catch(() => null),
    apiJson<{ siteName?: string }>("/api/v1/settings/public").catch(() => null),
  ]);
  const cards = (all ?? []).filter((v) => wanted.has(v.id));
  const network = typeof ssid?.value === "string" ? ssid.value.trim() : "";
  const siteName = site?.siteName?.trim() || "Guest Wi-Fi";

  return (
    <main className="min-h-screen bg-slate-100 px-3 py-6 text-slate-900 print:bg-white print:p-0 dark:bg-slate-900 print:dark:bg-white">
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center gap-3 print:hidden">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {all === null ? "The vouchers could not be read." : `${cards.length} card${cards.length === 1 ? "" : "s"}.`}
        </p>
        <span className="ml-auto">
          <PrintButton />
        </span>
      </div>
      <div className="mx-auto grid max-w-[210mm] grid-cols-2 gap-[4mm] bg-white p-[8mm] shadow print:max-w-none print:p-0 print:shadow-none">
        {cards.map((v) => (
          <section key={v.id} className="break-inside-avoid rounded border border-dashed border-slate-400 p-[5mm] text-center">
            <p className="text-sm font-semibold">{siteName}</p>
            <p className="text-xs text-slate-600">Guest Wi-Fi{network ? `: join "${network}"` : ""}</p>
            <p className="my-[3mm] font-mono text-3xl font-bold tracking-wider">{v.code}</p>
            <p className="text-xs text-slate-700">
              Type this code when the Wi-Fi page asks. Lasts {describeVoucherMinutes(v.minutes)} from first use
              {v.uses === 1 ? ", on one device" : v.uses > 1 ? `, on up to ${v.uses} devices` : ""}.
            </p>
            {v.note ? <p className="mt-[2mm] text-[10px] text-slate-500">{v.note}</p> : null}
          </section>
        ))}
      </div>
    </main>
  );
}
