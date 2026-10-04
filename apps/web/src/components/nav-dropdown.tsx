"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { ChevronDown } from "lucide-react";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export interface NavDropdownItem {
  href: string;
  label: string;
  Icon?: IconType;
  /** Mark "Soon" / disabled items. Rendered with muted styling and no link. */
  disabled?: boolean;
  /** Optional small badge text shown to the right of the label. */
  badge?: string;
}

/** A non-clickable group heading that visually splits a long dropdown. */
export interface NavDropdownHeader {
  header: string;
}

export type NavDropdownEntry = NavDropdownItem | NavDropdownHeader;

function isHeader(e: NavDropdownEntry): e is NavDropdownHeader {
  return "header" in e;
}

/**
 * Accessible click-to-open dropdown for the topbar. Closes on Esc, outside
 * click, and any link click. We deliberately don't open on hover — mouse
 * users get less surprise, touch users get parity. Hover only adds a colour
 * affordance to the trigger.
 */
/**
 * Visual tone for the trigger button. "default" matches every other top-nav
 * dropdown; "accent" uses brand colours to flag elevated/admin-only menus
 * so they stand out from the regular nav (only admins see them anyway,
 * since the parent gates by permission).
 */
export type NavDropdownTone = "default" | "accent";

export function NavDropdown({
  label,
  Icon,
  items,
  align = "left",
  tone = "default",
}: {
  label: string;
  Icon?: IconType;
  items: NavDropdownEntry[];
  /** Which side of the trigger the dropdown anchors to. */
  align?: "left" | "right";
  tone?: NavDropdownTone;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Resolve trigger classes per tone. Accent variant has its own border +
  // brand-tinted background so it pops next to the muted default triggers.
  const triggerBase = "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition";
  const triggerByTone: Record<NavDropdownTone, { base: string; open: string; icon: string }> = {
    default: {
      base: "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
      open: "bg-slate-100 dark:bg-slate-800",
      icon: "",
    },
    accent: {
      // Blue text/icon flags this as elevated without an outline; matches
      // the default dropdowns' minimal chrome but reads as distinct at a
      // glance.
      base: "text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:text-blue-200 dark:hover:bg-blue-900/30",
      open: "bg-blue-50 dark:bg-blue-900/30",
      icon: "text-blue-600 dark:text-blue-300",
    },
  };
  const t = triggerByTone[tone];

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${triggerBase} ${t.base} ${open ? t.open : ""}`}
      >
        {Icon ? <Icon className={`h-4 w-4 ${t.icon}`} aria-hidden /> : null}
        <span>{label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          role="menu"
          className={`fx-solid absolute z-50 mt-1 min-w-[14rem] rounded-md border border-slate-300 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item, idx) =>
            isHeader(item) ? (
              <DropdownHeader key={`h-${item.header}`} label={item.header} first={idx === 0} />
            ) : item.disabled ? (
              <DropdownDisabledItem key={item.label} item={item} />
            ) : (
              <DropdownLinkItem
                key={item.label}
                item={item}
                onNavigate={() => setOpen(false)}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function DropdownLinkItem({
  item,
  onNavigate,
}: {
  item: NavDropdownItem;
  onNavigate: () => void;
}) {
  return (
    <Link
      role="menuitem"
      href={item.href}
      onClick={onNavigate}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      {item.Icon ? <item.Icon className="h-4 w-4 text-slate-500" aria-hidden /> : null}
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge ? (
        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

function DropdownHeader({ label, first }: { label: string; first: boolean }) {
  return (
    <div
      className={`px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 ${
        first ? "" : "mt-1 border-t border-slate-100 dark:border-slate-800"
      }`}
    >
      {label}
    </div>
  );
}

function DropdownDisabledItem({ item }: { item: NavDropdownItem }) {
  return (
    <div
      role="menuitem"
      aria-disabled="true"
      title={item.badge ?? "Coming soon"}
      className="flex cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-400 dark:text-slate-500"
    >
      {item.Icon ? <item.Icon className="h-4 w-4" aria-hidden /> : null}
      <span className="flex-1 truncate">{item.label}</span>
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        {item.badge ?? "Soon"}
      </span>
    </div>
  );
}
