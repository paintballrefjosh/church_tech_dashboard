"use client";

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every minute. The first render uses `serverNow` (the snapshot's
 * `generatedAt`) so the server and the browser print the same markup; the real clock takes over
 * right after mount.
 */
export function useNow(serverNow: string): Date {
  const [now, setNow] = useState<Date>(() => new Date(serverNow));
  useEffect(() => {
    setNow(new Date());
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = new Date();
      setNow(t);
      timer = setTimeout(tick, 60_000 - (t.getTime() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);
  return now;
}
