"use client";

import { useEffect, useState } from "react";

/** "just now", "38 min ago", "in 3 h", "2 d ago": a short phrase for the distance from `now`. */
export function relativeTimeText(target: Date, now: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const future = diffMs > 0;
  const mins = Math.round(Math.abs(diffMs) / 60_000);
  if (mins < 1) return "just now";
  let amount: string;
  if (mins < 60) amount = `${mins} min`;
  else if (mins < 60 * 24) amount = `${Math.round(mins / 60)} h`;
  else amount = `${Math.round(mins / (60 * 24))} d`;
  return future ? `in ${amount}` : `${amount} ago`;
}

/**
 * A `<time>` showing how long ago (or from now) `at` is. Refreshes every minute. The first render
 * uses `serverNow` when given (the snapshot's `generatedAt`), so server and client agree and
 * hydration does not warn; it corrects itself on the first tick after mount.
 */
export function RelativeTime({
  at,
  serverNow,
  className,
}: {
  at: string | Date;
  serverNow?: string | Date;
  className?: string;
}) {
  const target = at instanceof Date ? at : new Date(at);
  const [now, setNow] = useState<Date>(() => (serverNow ? new Date(serverNow) : new Date()));

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (Number.isNaN(target.getTime())) return null;
  return (
    <time dateTime={target.toISOString()} title={target.toLocaleString()} className={className} suppressHydrationWarning>
      {relativeTimeText(target, now)}
    </time>
  );
}
