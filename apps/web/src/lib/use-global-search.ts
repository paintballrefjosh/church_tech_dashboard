"use client";

import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "@/lib/search-kinds";

export interface UseGlobalSearchOptions {
  /** Most results asked of `/api/search`. */
  limit?: number;
  /** Quiet time after a keystroke before the request goes out. */
  debounceMs?: number;
}

/**
 * The debounced `/api/search` query shared by the top bar, the Cmd/Ctrl-K palette and the home
 * page's search field. A slow answer to an older query never replaces a newer one.
 */
export function useGlobalSearch({ limit = 10, debounceMs = 150 }: UseGlobalSearchOptions = {}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    const mine = ++seq.current;
    if (!term) {
      setHits([]);
      setBusy(false);
      return;
    }
    // An older request still in flight is cancelled when the text changes again, not just ignored.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}&limit=${limit}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (mine !== seq.current) return;
        if (r.ok) {
          const body = (await r.json()) as { hits?: SearchHit[] };
          setHits(body.hits ?? []);
        }
      } catch {
        if (mine === seq.current) setHits([]);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, limit, debounceMs]);

  function clear() {
    setQ("");
    setHits([]);
  }

  return { q, setQ, hits, busy, clear };
}
