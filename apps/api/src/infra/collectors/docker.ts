import { sshExec } from "./ssh";
import { type CollectContext, type CollectResult, type CollectedEntity, emptyResult } from "./types";

/**
 * Docker collection is agentless over SSH: we run the `docker` CLI on the
 * remote host (`docker ps` + `docker stats`) and parse the JSON line output.
 * This reuses the same SSH credential as a Linux host and needs no daemon
 * socket exposed. The polling user must be in the `docker` group on the host.
 */
const SCRIPT = [
  "echo M_VER",
  "docker version --format '{{.Server.Version}}' 2>&1",
  "echo M_PS",
  "docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null",
  "echo M_STATS",
  "docker stats --no-stream --no-trunc --format '{{json .}}' 2>/dev/null",
].join("; ");

/** Parse "523.4MiB" / "1.55GiB" / "2kB" → bytes. */
function toBytes(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^([\d.]+)\s*([KMGT]?i?B)?$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toLowerCase();
  const mult: Record<string, number> = {
    b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  };
  return Number.isFinite(n) ? n * (mult[unit] ?? 1) : null;
}

function pct(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

/** "abc / def" → [abc, def] bytes. */
function pair(s: string | undefined): [number | null, number | null] {
  if (!s) return [null, null];
  const [a, b] = s.split("/").map((x) => x.trim());
  return [toBytes(a), toBytes(b)];
}

function healthFromStatus(status: string): string | null {
  const m = /\((healthy|unhealthy|health: starting|starting)\)/i.exec(status);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return h.includes("start") ? "starting" : h;
}

function parseJsonLines(block: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const line of block) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

export async function collectDocker(ctx: CollectContext): Promise<CollectResult> {
  let out: string;
  let hostKey: string | null;
  try {
    // See linux.ts's collectLinux for why this needs a bound — without it, a
    // target that goes unreachable mid-command hangs this poll (and this
    // target's polling) forever.
    const res = await sshExec(ctx, SCRIPT, { execTimeoutMs: ctx.options.timeoutMs ?? 15_000 });
    out = res.stdout;
    hostKey = res.hostKey;
  } catch (err) {
    return { ...emptyResult((err as Error).message), hostKey: ctx.knownHostKey };
  }

  const blocks = new Map<string, string[]>();
  let current = "";
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^M_[A-Z]+$/.test(line)) {
      current = line;
      blocks.set(current, []);
    } else if (current) {
      blocks.get(current)!.push(line);
    }
  }

  const verLine = (blocks.get("M_VER") ?? []).join("").trim();
  // A clean version string means the daemon answered. Anything else (command
  // not found, permission denied, cannot connect) is a down condition.
  if (!/^\d+\.\d+/.test(verLine)) {
    return {
      ...emptyResult(`docker unreachable: ${verLine || "no response"}`),
      hostKey,
    };
  }

  const psRows = parseJsonLines(blocks.get("M_PS") ?? []);
  const statsRows = parseJsonLines(blocks.get("M_STATS") ?? []);
  const statsByName = new Map<string, Record<string, string>>();
  for (const s of statsRows) {
    const name = s.Name ?? s.Container ?? "";
    if (name) statsByName.set(name, s);
  }

  const entities: CollectedEntity[] = [];
  let running = 0;
  let stopped = 0;
  let unhealthy = 0;
  let cpuSum = 0;
  let cpuSeen = false;

  for (const c of psRows) {
    const id = c.ID ?? c.Id ?? "";
    const name = c.Names ?? c.Name ?? id.slice(0, 12);
    const state = (c.State ?? "").toLowerCase();
    const status = c.Status ?? "";
    const health = healthFromStatus(status);
    if (state === "running") running++;
    else stopped++;
    if (health === "unhealthy") unhealthy++;

    // compose project label for stack grouping.
    const labels = c.Labels ?? "";
    const projMatch = /com\.docker\.compose\.project=([^,]+)/.exec(labels);
    const groupKey = projMatch ? projMatch[1]! : null;

    const st = statsByName.get(name);
    const cpu = pct(st?.CPUPerc);
    const [memUsed, memLimit] = pair(st?.MemUsage);
    const memP = pct(st?.MemPerc);
    const [netRx, netTx] = pair(st?.NetIO);
    const [blkR, blkW] = pair(st?.BlockIO);
    if (cpu !== null) {
      cpuSum += cpu;
      cpuSeen = true;
    }

    entities.push({
      entityKind: "container",
      externalId: id || name,
      name,
      groupKey,
      status: state || "unknown",
      health,
      state: {
        image: c.Image ?? null,
        statusText: status,
        composeProject: groupKey,
        composeService: /com\.docker\.compose\.service=([^,]+)/.exec(labels)?.[1] ?? null,
        // Latest scalars mirrored here so the container table renders without a
        // per-container time-series query.
        cpuPct: cpu,
        memPct: memP,
        memUsedBytes: memUsed,
        memLimitBytes: memLimit,
      },
      sample:
        state === "running"
          ? {
              cpuPct: cpu,
              memPct: memP,
              diskPctMax: null,
              metrics: {
                memUsedBytes: memUsed,
                memLimitBytes: memLimit,
                netRxBytes: netRx,
                netTxBytes: netTx,
                blockReadBytes: blkR,
                blockWriteBytes: blkW,
              },
            }
          : undefined,
    });
  }

  const metrics: Record<string, unknown> = {
    dockerVersion: verLine,
    counts: { total: psRows.length, running, stopped, unhealthy },
  };

  return {
    ok: true,
    hostKey,
    target: {
      cpuPct: cpuSeen ? Math.round(cpuSum * 10) / 10 : null,
      memPct: null,
      diskPctMax: null,
      metrics,
    },
    entities,
  };
}
