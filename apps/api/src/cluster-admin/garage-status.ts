import type { ClusterStoreNode } from "@church/shared";

/** The parts of Garage's admin API `GetClusterStatus` answer the Cluster page uses. */
interface GarageNode {
  id?: string;
  addr?: string | null;
  isUp?: boolean;
  lastSeenSecsAgo?: number | null;
  draining?: boolean;
  role?: { zone?: string; capacity?: number | null } | null;
  dataPartition?: { available?: number; total?: number } | null;
}

export function parseGarageStatus(body: unknown): { layoutVersion: number; nodes: ClusterStoreNode[] } {
  const b = (body ?? {}) as { layoutVersion?: number; nodes?: GarageNode[] };
  return {
    layoutVersion: Number(b.layoutVersion ?? 0),
    nodes: (b.nodes ?? []).map((n) => ({
      id: String(n.id ?? ""),
      addr: n.addr ?? null,
      zone: n.role?.zone ?? null,
      capacityBytes: n.role?.capacity ?? null,
      up: n.isUp === true,
      lastSeenSecsAgo: n.lastSeenSecsAgo ?? null,
      dataAvailableBytes: n.dataPartition?.available ?? null,
      dataTotalBytes: n.dataPartition?.total ?? null,
      draining: n.draining === true,
    })),
  };
}

/** Garage's status from its admin API, or null when it is not configured or does not answer. */
export async function fetchGarageStatus(
  url: string | undefined,
  token: string | undefined,
  timeoutMs = 2500,
): Promise<ReturnType<typeof parseGarageStatus> | null> {
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v2/GetClusterStatus`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parseGarageStatus(await res.json());
  } catch {
    return null;
  }
}
