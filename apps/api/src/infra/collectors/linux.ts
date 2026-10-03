import { sshExec } from "./ssh";
import { type CollectContext, type CollectResult, emptyResult, isIgnoredMount } from "./types";

/**
 * One SSH round-trip reads everything we need from /proc + df. CPU% needs a
 * delta, so we snapshot /proc/stat twice ~0.4s apart inside the same command.
 * Net/disk-IO are cumulative kernel counters, turned into per-second rates
 * against the previous poll (carried in ctx.prev).
 */
const BASE_SCRIPT = [
  'echo M_CPU1', "grep '^cpu' /proc/stat",
  'sleep 0.4',
  'echo M_CPU2', "grep '^cpu' /proc/stat",
  'echo M_MEM', 'cat /proc/meminfo',
  'echo M_LOAD', 'cat /proc/loadavg',
  'echo M_UP', 'cat /proc/uptime',
  'echo M_DF', 'df -PB1 2>/dev/null',
  'echo M_NET', 'cat /proc/net/dev',
  'echo M_DISK', 'cat /proc/diskstats',
  'echo M_PROC', 'ps -e --no-headers 2>/dev/null | wc -l',
  'echo M_TEMP', 'cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo NA',
  // A VM's ACPI thermal zone is frequently either absent (null already
  // handled above) or a fake, hypervisor-synthesized value — a real number
  // that isn't actually a sensor reading, so the web UI can't tell "no data"
  // from "bogus data" off temperatureC alone. systemd-detect-virt is the
  // standard, always-available (any systemd host, which is effectively every
  // supported distro here) way to know for sure; `$(...)` captures its
  // stdout regardless of exit code (it exits non-zero for the bare-metal
  // "none" case too, which would make a `cmd || echo none` fallback print
  // "none" twice).
  'echo M_VIRT', 'VIRT="$(systemd-detect-virt 2>/dev/null)"; [ -z "$VIRT" ] && VIRT=none; echo "$VIRT"',
].join('; ');

/** POSIX sh single-quote escaping for a value embedded in a remote command string. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `systemctl is-active` prints one status line per unit, in argument order —
 * so we can zip the output back up with `watched` by index without the
 * remote side needing to echo the name back (sidesteps having to parse names
 * with spaces out of the output).
 */
function serviceScript(watched: string[]): string {
  if (watched.length === 0) return "echo M_SVC";
  return `echo M_SVC; systemctl is-active ${watched.map(shQuote).join(" ")} 2>/dev/null`;
}

/**
 * On-demand probe (not part of the regular poll) listing every systemd
 * service unit systemd knows about, so the UI can offer a picker instead of
 * requiring the operator to type an exact unit name from memory.
 */
export async function discoverLinuxServices(
  ctx: CollectContext,
): Promise<Array<{ name: string; active: boolean; status: string }>> {
  const res = await sshExec(ctx, "systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null", {
    execTimeoutMs: ctx.options.timeoutMs ?? 15_000,
  });
  const services: Array<{ name: string; active: boolean; status: string }> = [];
  for (const l of res.stdout.split("\n")) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const unit = parts[0]!;
    if (!unit.endsWith(".service")) continue;
    const status = parts[2]!; // ACTIVE column of UNIT LOAD ACTIVE SUB DESCRIPTION
    services.push({ name: unit.replace(/\.service$/, ""), active: status === "active", status });
  }
  return services;
}

interface CpuTimes {
  total: number;
  idle: number;
}

function parseCpu(line: string): { key: string; times: CpuTimes } | null {
  const parts = line.trim().split(/\s+/);
  const key = parts[0];
  if (!key || !key.startsWith("cpu")) return null;
  const nums = parts.slice(1).map((n) => Number(n) || 0);
  if (nums.length < 5) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  // idle + iowait are the "not busy" buckets.
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
  return { key, times: { total, idle } };
}

function busyPct(a: CpuTimes, b: CpuTimes): number | null {
  const dt = b.total - a.total;
  if (dt <= 0) return null;
  const di = b.idle - a.idle;
  return Math.max(0, Math.min(100, (1 - di / dt) * 100));
}

function section(blocks: Map<string, string[]>, name: string): string[] {
  return blocks.get(name) ?? [];
}

export async function collectLinux(ctx: CollectContext): Promise<CollectResult> {
  const watchedServices = ((ctx.options.watchedServices as string[] | undefined) ?? []).filter(
    (s) => s.trim() !== "",
  );
  const script = `${BASE_SCRIPT}; ${serviceScript(watchedServices)}`;

  let out: string;
  let hostKey: string | null;
  try {
    // Without this, a poll whose target goes unreachable mid-command (e.g.
    // rebooting) hangs the exec promise forever — sshExec has no default
    // exec-level bound, only a connect-handshake one — which permanently
    // freezes this target's polling (InfraCollector's inFlight guard never
    // clears) until the api process itself restarts. Reuses the same
    // options.timeoutMs knob as the connect handshake, matching its existing
    // doc comment ("SSH timeout ... for a single poll's command batch").
    const res = await sshExec(ctx, script, { execTimeoutMs: ctx.options.timeoutMs ?? 15_000 });
    out = res.stdout;
    hostKey = res.hostKey;
  } catch (err) {
    return { ...emptyResult((err as Error).message), hostKey: ctx.knownHostKey };
  }

  // Split the marker-delimited output into named sections.
  const blocks = new Map<string, string[]>();
  let current = "";
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^M_[A-Z0-9]+$/.test(line)) {
      current = line;
      blocks.set(current, []);
    } else if (current) {
      blocks.get(current)!.push(line);
    }
  }

  const metrics: Record<string, unknown> = {};

  // ---- CPU (overall + per-core) ----
  const cpu1 = new Map<string, CpuTimes>();
  for (const l of section(blocks, "M_CPU1")) {
    const p = parseCpu(l);
    if (p) cpu1.set(p.key, p.times);
  }
  const perCore: Record<string, number> = {};
  let cpuPct: number | null = null;
  for (const l of section(blocks, "M_CPU2")) {
    const p = parseCpu(l);
    if (!p) continue;
    const prev = cpu1.get(p.key);
    if (!prev) continue;
    const pct = busyPct(prev, p.times);
    if (pct === null) continue;
    if (p.key === "cpu") cpuPct = pct;
    else perCore[p.key] = Math.round(pct * 10) / 10;
  }
  metrics.cpu = { totalPct: cpuPct, perCore };

  // ---- Memory ----
  const mem: Record<string, number> = {};
  for (const l of section(blocks, "M_MEM")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(l);
    if (m) mem[m[1]!] = Number(m[2]) * 1024; // bytes
  }
  const memTotal = mem.MemTotal ?? 0;
  const memAvail = mem.MemAvailable ?? 0;
  let memPct: number | null = null;
  if (memTotal > 0) memPct = Math.max(0, Math.min(100, (1 - memAvail / memTotal) * 100));
  metrics.memory = {
    totalBytes: memTotal,
    availableBytes: memAvail,
    usedBytes: memTotal - memAvail,
    cachedBytes: mem.Cached ?? 0,
    buffersBytes: mem.Buffers ?? 0,
    swapTotalBytes: mem.SwapTotal ?? 0,
    swapFreeBytes: mem.SwapFree ?? 0,
    usedPct: memPct,
  };

  // ---- Load average + uptime ----
  const loadLine = section(blocks, "M_LOAD")[0] ?? "";
  const lp = loadLine.trim().split(/\s+/).map(Number);
  metrics.load = { one: lp[0] ?? null, five: lp[1] ?? null, fifteen: lp[2] ?? null };
  const upLine = section(blocks, "M_UP")[0] ?? "";
  metrics.uptimeSec = Number(upLine.trim().split(/\s+/)[0]) || null;

  // ---- Filesystems ----
  const filesystems: Array<{ mount: string; sizeBytes: number; usedBytes: number; pct: number; ignored: boolean }> =
    [];
  let diskPctMax: number | null = null;
  const dfLines = section(blocks, "M_DF").slice(1); // drop header
  for (const l of dfLines) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const size = Number(parts[1]);
    const used = Number(parts[2]);
    const mount = parts.slice(5).join(" ");
    if (!Number.isFinite(size) || size <= 0) continue;
    // Skip pseudo/overlay mounts that inflate the list.
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount) && mount !== "/dev") continue;
    const pct = Math.round((used / size) * 1000) / 10;
    const ignored = isIgnoredMount(ctx, mount);
    filesystems.push({ mount, sizeBytes: size, usedBytes: used, pct, ignored });
    if (!ignored && (diskPctMax === null || pct > diskPctMax)) diskPctMax = pct;
  }
  metrics.filesystems = filesystems;

  // ---- Network (rates vs previous poll) ----
  const prev = (ctx.prev ?? {}) as {
    ts?: number;
    net?: Record<string, { rx: number; tx: number }>;
    disk?: Record<string, { read: number; write: number }>;
  };
  const nowMs = Date.now();
  const dtSec = prev.ts ? Math.max(1, (nowMs - prev.ts) / 1000) : null;

  const netNow: Record<string, { rx: number; tx: number }> = {};
  const interfaces: Array<{
    iface: string;
    rxBytes: number;
    txBytes: number;
    rxBytesPerSec: number | null;
    txBytesPerSec: number | null;
  }> = [];
  for (const l of section(blocks, "M_NET")) {
    const m = /^\s*([\w.-]+):\s*(.+)$/.exec(l);
    if (!m) continue;
    const iface = m[1]!;
    if (iface === "lo") continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    const rx = f[0] ?? 0;
    const tx = f[8] ?? 0;
    netNow[iface] = { rx, tx };
    const p = prev.net?.[iface];
    interfaces.push({
      iface,
      rxBytes: rx,
      txBytes: tx,
      rxBytesPerSec: p && dtSec ? Math.max(0, (rx - p.rx) / dtSec) : null,
      txBytesPerSec: p && dtSec ? Math.max(0, (tx - p.tx) / dtSec) : null,
    });
  }
  metrics.interfaces = interfaces;

  // ---- Disk IO (rates vs previous poll) ----
  const SECTOR = 512;
  const diskNow: Record<string, { read: number; write: number }> = {};
  const disks: Array<{
    device: string;
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
  }> = [];
  for (const l of section(blocks, "M_DISK")) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const dev = parts[2]!;
    // Skip partitions + loop/ram devices; keep whole disks (sd*, nvme*n1, vd*, xvd*).
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|dm-\d+)$/.test(dev)) continue;
    const sectorsRead = Number(parts[5]) || 0;
    const sectorsWritten = Number(parts[9]) || 0;
    diskNow[dev] = { read: sectorsRead, write: sectorsWritten };
    const p = prev.disk?.[dev];
    disks.push({
      device: dev,
      readBytesPerSec: p && dtSec ? Math.max(0, ((sectorsRead - p.read) * SECTOR) / dtSec) : null,
      writeBytesPerSec: p && dtSec ? Math.max(0, ((sectorsWritten - p.write) * SECTOR) / dtSec) : null,
    });
  }
  metrics.disks = disks;

  // ---- Misc ----
  metrics.processes = Number((section(blocks, "M_PROC")[0] ?? "").trim()) || null;
  const tempRaw = (section(blocks, "M_TEMP")[0] ?? "").trim();
  metrics.temperatureC = tempRaw && tempRaw !== "NA" ? Number(tempRaw) / 1000 : null;
  const virtRaw = (section(blocks, "M_VIRT")[0] ?? "").trim();
  metrics.isVirtual = virtRaw !== "" && virtRaw !== "none";
  metrics.virtType = metrics.isVirtual ? virtRaw : null;

  // ---- Watched services (systemd) ----
  const svcLines = section(blocks, "M_SVC");
  const services = watchedServices.map((name, i) => {
    const status = (svcLines[i] ?? "").trim() || "unknown";
    return { name, active: status === "active", status };
  });
  metrics.services = services;
  metrics.servicesDownCount = services.filter((s) => !s.active).length;

  return {
    ok: true,
    hostKey,
    target: { cpuPct, memPct, diskPctMax, metrics },
    entities: [],
    prev: { ts: nowMs, net: netNow, disk: diskNow },
  };
}
