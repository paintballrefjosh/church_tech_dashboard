"use client";

import Link from "next/link";
import { Figtree } from "next/font/google";
import { BookOpen, ListChecks, StickyNote, Ticket, type LucideIcon } from "lucide-react";
import { summarize } from "@church/shared";
import type { LookProps } from "../../look-props";
import { useHomeSnapshot } from "../../use-home-snapshot";
import { SearchField } from "../../parts/search-field";
import { LookPickerButton } from "../../picker/look-picker";
import { NeedsSection } from "./needs-list";
import { SideColumn } from "./side-column";
import s from "./styles.module.css";

const figtree = Figtree({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], display: "swap" });

const GREETING = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" } as const;

const CREATE: { module: string; href: string; label: string; Icon: LucideIcon }[] = [
  { module: "tickets", href: "/tickets/new", label: "New ticket", Icon: Ticket },
  { module: "wiki", href: "/wiki/new", label: "New wiki page", Icon: BookOpen },
  { module: "notes", href: "/notes", label: "New note", Icon: StickyNote },
  { module: "checklists", href: "/checklists", label: "Checklists", Icon: ListChecks },
];

export default function StartLook(props: LookProps) {
  const { snapshot, refresh } = useHomeSnapshot(props.snapshot, []);
  const tokens = summarize(snapshot);
  const chips = CREATE.filter((c) => props.me.access[c.module] !== undefined);
  const tagline = snapshot.site.tagline.trim();

  return (
    <div data-look="start" className={`${s.root} ${figtree.className}`}>
      <header className={s.hello}>
        <h1>
          {GREETING[snapshot.dayPart]}, {snapshot.user.firstName}
        </h1>
        <p className={s.summary}>
          {tokens.length === 0
            ? "Here's what needs your attention."
            : tokens.map((t, i) =>
                t.kind === "text" ? (
                  <span key={i} className={s.num}>
                    {t.text}
                  </span>
                ) : (
                  <Link
                    key={i}
                    href={t.href}
                    className={`${s.tok} ${s.num} ${t.tone === "bad" ? s.tokBad : t.tone === "warn" ? s.tokWarn : ""}`}
                  >
                    <i aria-hidden />
                    {t.text}
                  </Link>
                ),
              )}
        </p>
      </header>

      <div className={s.search} role="search">
        <SearchField
          placeholder="Search tickets, wiki pages, notes, hosts and devices"
          inputClassName={s.searchInput}
          panelClassName={s.searchPanel}
          iconClassName={s.searchIcon}
          trailing={<kbd className={s.kbd}>Ctrl K</kbd>}
        />
      </div>
      {chips.length > 0 ? (
        <ul className={s.chips} aria-label="Create">
          {chips.map(({ href, label, Icon }) => (
            <li key={href}>
              <Link href={href}>
                <Icon aria-hidden />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <main className={s.body}>
        <NeedsSection snapshot={snapshot} refresh={() => void refresh()} />
        <SideColumn snapshot={snapshot} />
      </main>

      <footer className={s.foot}>
        {tagline ? <p>{tagline}</p> : null}
        <LookPickerButton className={s.picker} />
      </footer>
    </div>
  );
}
