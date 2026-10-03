/**
 * Best-effort probe of the Fiery REST API for active-job count. EFI Fiery API
 * v5 uses an `api-key` header for auth. Older firmware needs session login —
 * not handled here. On any failure (no URL, wrong key, server down, JSON
 * shape change) we return `{ queueDepth: null, error }` and the caller leaves
 * the SNMP-derived status alone.
 */
export interface FieryProbeOptions {
  apiUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface FieryProbeResult {
  queueDepth: number | null;
  error?: string;
}

export async function probeFieryQueue(opts: FieryProbeOptions): Promise<FieryProbeResult> {
  if (!opts.apiUrl) return { queueDepth: null, error: "no fiery api url" };
  // Trim a trailing slash so we don't end up with `//live`.
  const base = opts.apiUrl.replace(/\/+$/, "");
  const url = `${base}/live/api/v5/jobs?status=printing,spooling`;
  try {
    const res = await fetch(url, {
      headers: {
        "api-key": opts.apiKey || "",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      return { queueDepth: null, error: `fiery http ${res.status}` };
    }
    const json = (await res.json()) as { items?: unknown[]; jobs?: unknown[] };
    const arr = Array.isArray(json.items)
      ? json.items
      : Array.isArray(json.jobs)
        ? json.jobs
        : null;
    if (!arr) {
      return { queueDepth: 0 };
    }
    return { queueDepth: arr.length };
  } catch (err) {
    return { queueDepth: null, error: (err as Error).message || "fiery error" };
  }
}
