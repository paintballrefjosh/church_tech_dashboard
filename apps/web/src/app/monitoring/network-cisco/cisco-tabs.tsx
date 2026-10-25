"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Archive, GitCompareArrows, Search, Network, Share2 } from "lucide-react";

const BASE = "/monitoring/network-cisco";

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
                : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" aria-hidden />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
