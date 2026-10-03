import { sshExec } from "./ssh";
import { splitSections, sectionLines, sectionFirst } from "./markers";
import { type CollectContext, type CollectResult, emptyResult, isIgnoredMount } from "./types";

/**
 * macOS host metrics over SSH (Remote Login must be enabled on the Mac). macOS
 * ships BSD userland, so the commands differ from Linux: no /proc, `df` lacks
 * `-B1`, memory accounting is page-based via `vm_stat`, and load/uptime come
 * from `sysctl`. One round-trip; `top -l 2` samples CPU across a short window
 * so the reading isn't the misleading first-sample spike.
 */
const SCRIPT = [
  "echo M_CPU", "top -l 2 -n 0 | grep -E '^CPU usage'",
  "echo M_MEMTOTAL", "sysctl -n hw.memsize",
  "echo M_PAGESIZE", "sysctl -n hw.pagesize",
  "echo M_VMSTAT", "vm_stat",
  "echo M_LOAD", "sysctl -n vm.loadavg",
  "echo M_BOOT", "sysctl -n kern.boottime",
  "echo M_DF", "df -k -l 2>/dev/null",
].join("; ");

export async function collectMac(ctx: CollectContext): Promise<CollectResult> {
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

  const blocks = splitSections(out);
  const metrics: Record<string, unknown> = {};

  // ---- CPU: parse the LAST "CPU usage: X% user, Y% sys, Z% idle" line ----
  let cpuPct: number | null = null;
  const cpuLines = sectionLines(blocks, "M_CPU").filter((l) => /CPU usage/.test(l));
  const cpuLine = cpuLines[cpuLines.length - 1] ?? "";
  const idleMatch = /([\d.]+)%\s*idle/.exec(cpuLine);
  if (idleMatch) cpuPct = Math.max(0, Math.min(100, 100 - Number(idleMatch[1])));
  metrics.cpu = { totalPct: cpuPct, perCore: {} };

  // ---- Memory: used = memsize - free-ish pages; via vm_stat page buckets ----
  const memTotal = Number(sectionFirst(blocks, "M_MEMTOTAL")) || 0;
  const pageSize = Number(sectionFirst(blocks, "M_PAGESIZE")) || 4096;
  const pages: Record<string, number> = {};
  for (const l of sectionLines(blocks, "M_VMSTAT")) {
    const m = /^"?([^":]+)"?:\s*(\d+)\.?/.exec(l.trim());
    if (m) pages[m[1]!.trim()] = Number(m[2]);
  }
  // "Used" ≈ active + wired + compressed (App + Wired + Compressed in Activity Monitor).
  const usedPages =
    (pages["Pages active"] ?? 0) +
    (pages["Pages wired down"] ?? 0) +
    (pages["Pages occupied by compressor"] ?? 0);
  const usedBytes = usedPages * pageSize;
  let memPct: number | null = null;
  if (memTotal > 0) memPct = Math.max(0, Math.min(100, (usedBytes / memTotal) * 100));
  metrics.memory = {
    totalBytes: memTotal,
    usedBytes,
    availableBytes: memTotal - usedBytes,
    usedPct: memPct,
  };

  // ---- Load average: "{ 1.20 1.10 1.05 }" ----
  const loadRaw = sectionFirst(blocks, "M_LOAD");
  const lp = (loadRaw.match(/[\d.]+/g) ?? []).map(Number);
  metrics.load = { one: lp[0] ?? null, five: lp[1] ?? null, fifteen: lp[2] ?? null };

  // ---- Uptime: kern.boottime = "{ sec = 1699999999, usec = 0 } ..." ----
  const boot = /sec\s*=\s*(\d+)/.exec(sectionFirst(blocks, "M_BOOT"));
  metrics.uptimeSec = boot ? Math.max(0, Math.floor(Date.now() / 1000) - Number(boot[1])) : null;

  // ---- Filesystems: `df -k` → 1024-byte blocks; skip pseudo mounts ----
  const filesystems: Array<{ mount: string; sizeBytes: number; usedBytes: number; pct: number; ignored: boolean }> =
    [];
  let diskPctMax: number | null = null;
  for (const l of sectionLines(blocks, "M_DF").slice(1)) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const size = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const mount = parts.slice(8).join(" ");
    if (!Number.isFinite(size) || size <= 0) continue;
    if (mount.startsWith("/dev") || mount.startsWith("/System/Volumes/VM")) continue;
    const pct = Math.round((used / size) * 1000) / 10;
    const ignored = isIgnoredMount(ctx, mount);
    filesystems.push({ mount, sizeBytes: size, usedBytes: used, pct, ignored });
    if (!ignored && (diskPctMax === null || pct > diskPctMax)) diskPctMax = pct;
  }
  metrics.filesystems = filesystems;

  return {
    ok: true,
    hostKey,
    target: { cpuPct, memPct, diskPctMax, metrics },
    entities: [],
  };
}
