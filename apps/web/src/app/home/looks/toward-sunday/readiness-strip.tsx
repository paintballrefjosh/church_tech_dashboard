"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { Check, TriangleAlert } from "lucide-react";
import type { Readiness } from "@church/shared";
import { readinessLine } from "./model";
import styles from "./toward-sunday.module.css";

export function ReadinessStrip({
  readiness,
  title,
  hasService,
}: {
  readiness: Readiness;
  title: string;
  hasService: boolean;
}) {
  const segments = Array.from({ length: readiness.total }, (_, i) => i < readiness.score);
  return (
    <section className={styles.ready} aria-labelledby="ts-ready-h" data-testid="readiness-strip">
      <div className={styles.readySum}>
        <h2 id="ts-ready-h">{title}</h2>
        <div>
          <div className={`${styles.score} ${styles.num}`}>
            <b>{readiness.score}</b> of {readiness.total}
          </div>
          <div className={styles.bar} aria-hidden="true">
            {segments.map((on, i) => (
              <i key={i} className={on ? styles.on : undefined} />
            ))}
          </div>
        </div>
        <p>{readinessLine(readiness.score, readiness.total, hasService)}</p>
      </div>
      <ul className={styles.checks} style={{ "--n": readiness.total } as CSSProperties}>
        {readiness.checks.map((c) => {
          const cls = `${styles.check} ${c.ok ? styles.cOk : styles.cWarn}`;
          const inner = (
            <>
              <span className={styles.st}>
                <span className={styles.badge}>
                  {c.ok ? <Check aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
                </span>
                {c.label}
                <span className={styles.sr}>{c.ok ? ": ready" : ": needs attention"}</span>
              </span>
              <span className={`${styles.v} ${styles.num}`}>{c.detail}</span>
            </>
          );
          return (
            <li key={c.key} data-check={c.key} data-ok={c.ok ? "true" : "false"}>
              {c.href ? (
                <Link href={c.href} className={cls}>
                  {inner}
                </Link>
              ) : (
                <div className={cls}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
