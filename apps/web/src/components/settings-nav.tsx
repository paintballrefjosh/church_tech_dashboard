"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

/** Side-by-side links between a module's settings pages (General, Security settings ...). */
export function SettingsNav({ label, items }: { label: string; items: NavItem[] }) {
  const p = usePathname();
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2 text-sm">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={p === i.href ? "page" : undefined}
          className={`inline-flex min-h-[32px] items-center rounded-md px-3 py-1.5 ${p === i.href ? "bg-brand-600 text-white" : "border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"}`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
