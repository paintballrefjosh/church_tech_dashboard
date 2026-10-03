import { Agent, fetch as undiciFetch } from "undici";
import { type CollectContext, type CollectResult, type CollectedEntity, emptyResult } from "./types";

/**
 * Proxmox VE collection over its REST API using an API token
 * (Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET). Homelab PVE nodes
 * almost always present a self-signed cert, so we default to not verifying TLS
 * unless a CA is pinned or allowSelfSigned is explicitly false. undici is used
 * (not global fetch) because it lets us scope the TLS setting per request.
 */
interface PveResource {
  type: string; // 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn' ...
  node?: string;
  status?: string;
  cpu?: number; // fraction 0..1
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  vmid?: number;
  name?: string;
  id?: string;
  storage?: string;
}

interface PveNodeStatus {
  cpu?: number;
  loadavg?: string[];
  uptime?: number;
  memory?: { total?: number; used?: number; free?: number };
  rootfs?: { total?: number; used?: number };
}

export async function collectProxmox(ctx: CollectContext): Promise<CollectResult> {
  const cred = ctx.credential;
  if (!cred?.username || !cred.secret) {
    return emptyResult("Proxmox target has no API token configured");
  }
  const port = ctx.options.port ?? 8006;
  const base = `https://${ctx.host}:${port}/api2/json`;
  const allowSelfSigned = ctx.options.allowSelfSigned ?? true;
  const dispatcher = new Agent({
    connect: {
      rejectUnauthorized: !allowSelfSigned,
      ca: cred.caCert ?? undefined,
    },
    headersTimeout: ctx.options.timeoutMs ?? 10_000,
    bodyTimeout: ctx.options.timeoutMs ?? 10_000,
  });
  const headers = { Authorization: `PVEAPIToken=${cred.username}=${cred.secret}` };

  const get = async <T>(path: string): Promise<T> => {
    const res = await undiciFetch(`${base}${path}`, { headers, dispatcher });
    if (!res.ok) throw new Error(`PVE ${path} -> ${res.status}`);
    const body = (await res.json()) as { data: T };
    return body.data;
  };

  let resources: PveResource[];
  try {
    resources = await get<PveResource[]>("/cluster/resources");
  } catch (err) {
    await dispatcher.close().catch(() => {});
    return emptyResult(`Proxmox unreachable: ${(err as Error).message}`);
  }

  // Cluster quorum (best-effort; single-node installs still answer).
  let quorate: boolean | null = null;
  try {
    const status = await get<Array<{ type: string; quorate?: number }>>("/cluster/status");
    const cluster = status.find((s) => s.type === "cluster");
    if (cluster && typeof cluster.quorate === "number") quorate = cluster.quorate === 1;
  } catch {
    /* best-effort */
  }

  const nodeFilter = ctx.options.proxmoxNodes;
  const wantNode = (n: string | undefined): boolean =>
    !nodeFilter || nodeFilter.length === 0 || (n != null && nodeFilter.includes(n));

  const entities: CollectedEntity[] = [];
  let maxNodeCpu: number | null = null;
  let maxNodeMem: number | null = null;
  let maxDisk: number | null = null;
  let guestsRunning = 0;
  let guestsStopped = 0;
  let blindNodes = 0;

  // Nodes — enrich with per-node status for loadavg/rootfs.
  for (const r of resources.filter((x) => x.type === "node")) {
    if (!wantNode(r.node)) continue;
    const nodeName = r.node ?? r.id ?? "node";
    let detail: PveNodeStatus = {};
    try {
      detail = await get<PveNodeStatus>(`/nodes/${encodeURIComponent(nodeName)}/status`);
    } catch {
      /* node may be offline */
    }
    const cpuPct = r.cpu != null ? Math.round(r.cpu * 1000) / 10 : null;
    const memPct = r.mem != null && r.maxmem ? Math.round((r.mem / r.maxmem) * 1000) / 10 : null;
    // An online node with no stats means the token can list it but lacks Sys.Audit.
    if (r.status === "online" && r.cpu == null && r.mem == null) blindNodes++;
    const rootTotal = detail.rootfs?.total ?? 0;
    const rootUsed = detail.rootfs?.used ?? 0;
    const rootPct = rootTotal > 0 ? Math.round((rootUsed / rootTotal) * 1000) / 10 : null;
    if (cpuPct !== null && (maxNodeCpu === null || cpuPct > maxNodeCpu)) maxNodeCpu = cpuPct;
    if (memPct !== null && (maxNodeMem === null || memPct > maxNodeMem)) maxNodeMem = memPct;
    if (rootPct !== null && (maxDisk === null || rootPct > maxDisk)) maxDisk = rootPct;
    entities.push({
      entityKind: "node",
      externalId: nodeName,
      name: nodeName,
      groupKey: null,
      status: r.status ?? "unknown",
      health: null,
      state: {
        cpuPct,
        memPct,
        diskPct: rootPct,
        maxcpu: r.maxcpu ?? null,
        memBytes: r.mem ?? null,
        maxmemBytes: r.maxmem ?? null,
        uptimeSec: r.uptime ?? detail.uptime ?? null,
        loadavg: detail.loadavg ?? null,
        rootfsTotalBytes: rootTotal || null,
        rootfsUsedBytes: rootUsed || null,
      },
      sample: {
        cpuPct,
        memPct,
        diskPctMax: rootPct,
        metrics: { loadavg: detail.loadavg ?? null },
      },
    });
  }

  // Guests (VMs + containers).
  for (const r of resources.filter((x) => x.type === "qemu" || x.type === "lxc")) {
    if (!wantNode(r.node)) continue;
    const runningState = r.status === "running";
    if (runningState) guestsRunning++;
    else guestsStopped++;
    const cpuPct = r.cpu != null ? Math.round(r.cpu * 1000) / 10 : null;
    const memPct = r.mem != null && r.maxmem ? Math.round((r.mem / r.maxmem) * 1000) / 10 : null;
    entities.push({
      entityKind: "guest",
      externalId: String(r.vmid ?? r.id ?? r.name),
      name: r.name ?? `vm-${r.vmid}`,
      groupKey: r.node ?? null,
      status: r.status ?? "unknown",
      health: null,
      state: {
        cpuPct,
        memPct,
        guestType: r.type,
        node: r.node ?? null,
        vmid: r.vmid ?? null,
        maxmemBytes: r.maxmem ?? null,
        maxdiskBytes: r.maxdisk ?? null,
        uptimeSec: r.uptime ?? null,
      },
      sample: runningState
        ? { cpuPct, memPct, diskPctMax: null, metrics: { memBytes: r.mem ?? null } }
        : undefined,
    });
  }

  // Storage pools.
  for (const r of resources.filter((x) => x.type === "storage")) {
    if (!wantNode(r.node)) continue;
    const usedPct = r.disk != null && r.maxdisk ? Math.round((r.disk / r.maxdisk) * 1000) / 10 : null;
    if (usedPct !== null && (maxDisk === null || usedPct > maxDisk)) maxDisk = usedPct;
    entities.push({
      entityKind: "storage",
      externalId: r.id ?? `${r.node}/${r.storage}`,
      name: r.storage ?? r.id ?? "storage",
      groupKey: r.node ?? null,
      status: r.status ?? "available",
      health: null,
      state: { usedBytes: r.disk ?? null, totalBytes: r.maxdisk ?? null, usedPct },
      sample: { cpuPct: null, memPct: null, diskPctMax: usedPct, metrics: {} },
    });
  }

  await dispatcher.close().catch(() => {});

  const nodeCount = entities.filter((e) => e.entityKind === "node").length;
  const metrics: Record<string, unknown> = {
    quorate,
    counts: {
      nodes: nodeCount,
      guests: guestsRunning + guestsStopped,
      guestsRunning,
      guestsStopped,
      storage: entities.filter((e) => e.entityKind === "storage").length,
    },
  };

  const warning =
    blindNodes > 0
      ? `Proxmox API token can see ${blindNodes} node(s) but returns no stats - grant it the PVEAuditor role on / (and disable Privilege Separation or give the token its own permission)`
      : undefined;

  return {
    ok: true,
    warning,
    target: { cpuPct: maxNodeCpu, memPct: maxNodeMem, diskPctMax: maxDisk, metrics },
    entities,
  };
}
