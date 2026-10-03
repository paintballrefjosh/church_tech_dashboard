"use client";

import { useEffect, useState } from "react";

/**
 * Server components format dates with Node's toLocaleString(), which runs in
 * the Docker container (UTC) rather than the viewer's browser — timestamps
 * were showing hours off for anyone not in UTC. This renders in the fallback
 * zone on first paint (matching SSR, avoiding a hydration mismatch) and swaps
 * to the browser's real, auto-detected zone once mounted.
 */
const FALLBACK_TIME_ZONE = "America/Chicago";

function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export function LocalDateTime({
  value,
  options,
  className,
}: {
  value: string | number | Date;
  options?: Intl.DateTimeFormatOptions;
  className?: string;
}) {
  const [timeZone, setTimeZone] = useState(FALLBACK_TIME_ZONE);

  useEffect(() => {
    setTimeZone(detectTimeZone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatted = new Date(value).toLocaleString(undefined, { timeZone, ...options });
  return (
    <span suppressHydrationWarning className={className}>
      {formatted}
    </span>
  );
}
