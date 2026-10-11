"use client";

import { useEffect, useState, type ReactNode } from "react";

export interface CountdownLeft {
  /** Whole days left (0 when under a day). */
  days: number;
  /** Hours left within the day, 0 to 23. */
  hours: number;
  minutes: number;
  seconds: number;
  /** Everything in milliseconds; never negative. */
  totalMs: number;
  /** True once `to` has passed. */
  done: boolean;
}

export function countdownLeft(to: Date, now: Date): CountdownLeft {
  const totalMs = Math.max(0, to.getTime() - now.getTime());
  const totalSec = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(totalSec / 86_400),
    hours: Math.floor((totalSec % 86_400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
    totalMs,
    done: to.getTime() <= now.getTime(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The default text: "2 d 4 h", "3 h 05 min", "12 min", or "00:42" in the last minute. */
export function defaultCountdownText(left: CountdownLeft, granularity: "minute" | "second"): string {
  if (left.done) return "now";
  if (left.days > 0) return `${left.days} d ${left.hours} h`;
  if (granularity === "second") {
    return left.hours > 0 ? `${left.hours}:${pad(left.minutes)}:${pad(left.seconds)}` : `${pad(left.minutes)}:${pad(left.seconds)}`;
  }
  if (left.hours > 0) return `${left.hours} h ${pad(left.minutes)} min`;
  return `${left.minutes} min`;
}

/**
 * Counts down to `to`, re-rendering on the minute (or the second). A look can style the default
 * text with `className`, or take over the markup with a render prop that receives the time left.
 *
 * Hydration: the first render uses `serverNow` (pass the snapshot's `generatedAt`) so the server
 * and the browser print the same text; the real clock takes over right after mount. Without
 * `serverNow` the first render is the current time and the text may differ by a tick.
 */
export function Countdown({
  to,
  granularity = "minute",
  serverNow,
  className,
  children,
}: {
  to: string | Date;
  granularity?: "minute" | "second";
  serverNow?: string | Date;
  className?: string;
  children?: (left: CountdownLeft) => ReactNode;
}) {
  const target = to instanceof Date ? to : new Date(to);
  const [now, setNow] = useState<Date>(() => (serverNow ? new Date(serverNow) : new Date()));

  useEffect(() => {
    const step = granularity === "second" ? 1000 : 60_000;
    setNow(new Date());
    let timer: ReturnType<typeof setTimeout>;
    // Aim for the next boundary so a minute counter turns over on the minute, not mid-way.
    const tick = () => {
      const t = new Date();
      setNow(t);
      timer = setTimeout(tick, step - (t.getTime() % step) + 5);
    };
    timer = setTimeout(tick, step - (Date.now() % step) + 5);
    return () => clearTimeout(timer);
  }, [granularity]);

  if (Number.isNaN(target.getTime())) return null;
  const left = countdownLeft(target, now);
  if (children) return <>{children(left)}</>;
  return (
    <span className={className} suppressHydrationWarning>
      {defaultCountdownText(left, granularity)}
    </span>
  );
}
