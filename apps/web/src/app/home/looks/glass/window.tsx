"use client";

import Link from "next/link";
import { memo, useRef, type CSSProperties, type MouseEvent } from "react";
import type { AreaKey, AvailabilityGrid } from "@church/shared";
import styles from "./glass.module.css";

/** How many shades each area's jewel has (see the --<area>-<n> tokens in the CSS). */
const SHADES: Record<AreaKey, number> = { servers: 5, internet: 4, wifi: 5, switches: 4, dns: 3, services: 3 };

/** A small stable hash (djb2): the same system and row always get the same shade. */
export function shadeIndex(ref: string, row: number, count: number): number {
  let h = 5381;
  const s = `${ref}:${row}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % count;
}

type Cell = AvailabilityGrid["groups"][number]["systems"][number]["cells"][number];
type Group = AvailabilityGrid["groups"][number];

const STATE_TEXT: Record<Cell, string> = { up: "up", partial: "partly down", down: "down", none: "no reading" };
const CELL_CLASS: Record<Cell, string> = { up: "", partial: styles.partial!, down: styles.down!, none: styles.none! };

function ago(h: number): string {
  return h === 0 ? "this hour" : `${h} h ago`;
}

/** Counts from the newest hour. Systems with no reading that hour are left out of both. */
export function groupCounts(g: Group): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const s of g.systems) {
    const c = s.cells[0];
    if (c === "down") down++;
    else if (c === "up" || c === "partial") up++;
  }
  return { up, down };
}

/** One sentence for assistive technology: how many are up this hour and which are down. */
export function mosaicSummary(grid: AvailabilityGrid): string {
  let up = 0;
  let total = 0;
  const down: string[] = [];
  for (const g of grid.groups) {
    for (const s of g.systems) {
      const c = s.cells[0];
      if (c === "none" || c === undefined) continue;
      total++;
      if (c === "down") down.push(s.name);
      else up++;
    }
  }
  if (total === 0) return "Uptime of every system over the last 12 hours. No readings for this hour yet.";
  const names = down.length > 3 ? `${down.slice(0, 3).join(", ")} and ${down.length - 3} more down` : `${down.join(", ")} down`;
  return `${up} of ${total} systems up this hour${down.length ? `; ${names}` : ""}. Each pane is one hour of one system, newest at the top, over the last 12 hours.`;
}

const GroupPanes = memo(function GroupPanes({ group, colStart }: { group: Group; colStart: number }) {
  return (
    <div className={styles.group} style={{ "--n": group.systems.length } as CSSProperties}>
      {group.systems.flatMap((s, i) =>
        s.cells.map((cell, h) => (
          <span
            key={`${s.ref}:${h}`}
            className={`${styles.pane} ${CELL_CLASS[cell]}`}
            data-tip={`${s.name}: ${STATE_TEXT[cell]}, ${ago(h)}`}
            style={
              {
                "--c": `var(--${group.area}-${shadeIndex(s.ref, h, SHADES[group.area])})`,
                "--d": Math.round((colStart + i) * 22 + h * 6),
              } as CSSProperties
            }
          />
        )),
      )}
    </div>
  );
});

/** The window: one pane per hour per system, plus the group labels beneath it. */
export function GlassWindow({ grid }: { grid: AvailabilityGrid }) {
  const tip = useRef<HTMLDivElement>(null);
  const total = grid.groups.reduce((n, g) => n + g.systems.length, 0);
  let col = 0;
  const starts = grid.groups.map((g) => {
    const s = col;
    col += g.systems.length;
    return s;
  });

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const el = tip.current;
    if (!el) return;
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!t) {
      el.classList.remove(styles.tipShow!);
      return;
    }
    el.textContent = t.dataset.tip ?? "";
    el.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 220)}px`;
    el.style.top = `${e.clientY + 14}px`;
    el.classList.add(styles.tipShow!);
  }
  function onLeave() {
    tip.current?.classList.remove(styles.tipShow!);
  }

  // How many of the 12 hours have any reading at all (the history is young after an install).
  let have = 0;
  for (const g of grid.groups) for (const s of g.systems) s.cells.forEach((c, i) => c !== "none" && (have = Math.max(have, i + 1)));

  return (
    <>
      <div className={styles.window} style={{ "--cols": total } as CSSProperties}>
        <div
          role="img"
          aria-label={mosaicSummary(grid)}
          className={styles.mosaic}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          {grid.groups.map((g, gi) => (
            <GroupPanes key={g.area} group={g} colStart={starts[gi]!} />
          ))}
        </div>
        <div className={styles.axis}>
          <span>Now, top row</span>
          <span>12 hours ago, bottom row</span>
        </div>
      </div>
      <div className={styles.glabels} style={{ "--cols": total } as CSSProperties}>
        {grid.groups.map((g) => {
          const { up, down } = groupCounts(g);
          return (
            <Link
              key={g.area}
              href={g.href}
              className={`${styles[`a_${g.area}`]} ${down > 0 ? styles.bad : ""}`}
              style={{ "--n": g.systems.length } as CSSProperties}
            >
              <b>{g.label}</b>
              <span className={styles.num}>{down > 0 ? `${up} up, ${down} down` : `${up} up`}</span>
            </Link>
          );
        })}
      </div>
      {have < 12 ? <p className={styles.note}>History builds up over the first 12 hours.</p> : null}
      <div ref={tip} className={styles.tip} aria-hidden="true" />
    </>
  );
}
