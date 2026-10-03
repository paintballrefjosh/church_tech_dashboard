"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, Archive, GitCompareArrows, Search, Network, Share2, Plus } from "lucide-react";
import { useCanWrite } from "./cisco-ui";

const BASE = "/monitoring/network-cisco";
export const CISCO_ADD_SWITCH_EVENT = "cisco:add-switch";
export const CISCO_ADD_SWITCH_FLAG = "cisco:add-switch-pending";

const TABS = [
  { href: BASE, label: "Dashboard", Icon: LayoutDashboard, exact: true },
  { href: `${BASE}/topology`, label: "Topology", Icon: Share2, exact: false },
  { href: `${BASE}/backups`, label: "Backups", Icon: Archive, exact: false },
  { href: `${BASE}/drift`, label: "Drift log", Icon: GitCompareArrows, exact: false },
  { href: `${BASE}/lookup`, label: "MAC / ARP", Icon: Search, exact: false },
  { href: `${BASE}/vlans`, label: "VLANs", Icon: Network, exact: false },
] as const;

export function CiscoTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const canWrite = useCanWrite();

  function addSwitch() {
    try {
      sessionStorage.setItem(CISCO_ADD_SWITCH_FLAG, "1");
    } catch {
      /* private mode */
    }
    window.dispatchEvent(new Event(CISCO_ADD_SWITCH_EVENT));
    if (pathname !== BASE) router.push(BASE);
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-1 text-xs">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition ${
              active
                ? "bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" aria-hidden />
            {t.label}
          </Link>
        );
      })}
      {canWrite ? (
        <button
          type="button"
          onClick={addSwitch}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1.5 font-medium text-white transition hover:bg-brand-700"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add switch
        </button>
      ) : null}
    </div>
  );
}
