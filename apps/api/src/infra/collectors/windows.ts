import { sshExec } from "./ssh";
import { splitSections, sectionLines, sectionFirst } from "./markers";
import { type CollectContext, type CollectResult, emptyResult, isIgnoredMount } from "./types";

/**
 * Windows host metrics over SSH. Requires the OpenSSH Server feature (built in
 * to Windows 10/11 + Server 2019+). The remote default shell is cmd.exe, so we
 * invoke PowerShell explicitly and have it emit marker lines + values via CIM
 * (WMI). All string literals inside the `-Command` are single-quoted so the
 * outer double-quotes survive the cmd.exe hop untouched.
 *
 * WinRM would be the more "native" transport but needs a new client stack and
 * credential type; SSH keeps one uniform base credential across all OSes.
 */
const PS_BASE = [
  "Write-Output 'M_CPU'",
  "Write-Output ((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)",
  "Write-Output 'M_MEM'",
  "$o=Get-CimInstance Win32_OperatingSystem",
  "Write-Output $o.TotalVisibleMemorySize",
  "Write-Output $o.FreePhysicalMemory",
  "Write-Output 'M_UP'",
  "Write-Output ([math]::Floor(((Get-Date)-$o.LastBootUpTime).TotalSeconds))",
  "Write-Output 'M_DISK'",
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { Write-Output ($_.DeviceID+' '+$_.Size+' '+$_.FreeSpace) }",
].join("; ");

/**
 * PS single-quoted string literal: double embedded single quotes. Also strips
 * backtick/double-quote — service names don't legitimately contain them, and
 * a `"` would otherwise break out of this whole command's outer cmd.exe
 * double-quoting (see the module doc comment above).
 */
function psQuote(s: string): string {
  return `'${s.replace(/[`"]/g, "").replace(/'/g, "''")}'`;
}

/**
 * One `Get-Service` call per watched name (not `-Name a,b,c`) so a missing
 * service still emits exactly one output line ("NotFound") instead of being
 * silently dropped — that keeps the output index-aligned with `watched` for
 * zipping back up, same trick as linux.ts's systemctl call.
 */
function serviceScript(watched: string[]): string {
  if (watched.length === 0) return "Write-Output 'M_SVC'";
  const list = watched.map(psQuote).join(",");
  return (
    "Write-Output 'M_SVC'; " +
    `foreach ($n in @(${list})) { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; ` +
    "if ($s) { Write-Output $s.Status } else { Write-Output 'NotFound' } }"
  );
}

/**
 * On-demand probe (not part of the regular poll) listing every Windows
 * service, so the UI can offer a picker instead of requiring the operator to
 * type an exact service name from memory. `|`-delimited (not whitespace) since
 * `Name` occasionally contains one, unlike the display name.
 */
export async function discoverWindowsServices(
  ctx: CollectContext,
): Promise<Array<{ name: string; active: boolean; status: string }>> {
  const script =
    'powershell -NoProfile -NonInteractive -Command "Get-Service | ForEach-Object { Write-Output ($_.Name+\'|\'+$_.Status) }"';
  const res = await sshExec(ctx, script, { execTimeoutMs: ctx.options.timeoutMs ?? 15_000 });
  const services: Array<{ name: string; active: boolean; status: string }> = [];
  for (const raw of res.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.lastIndexOf("|");
    if (idx < 0) continue;
    const name = line.slice(0, idx);
    const status = line.slice(idx + 1);
    services.push({ name, active: status === "Running", status });
  }
  return services;
}

export async function collectWindows(ctx: CollectContext): Promise<CollectResult> {
  const watchedServices = ((ctx.options.watchedServices as string[] | undefined) ?? []).filter(
    (s) => s.trim() !== "",
  );
  const script = `powershell -NoProfile -NonInteractive -Command "${PS_BASE}; ${serviceScript(watchedServices)}"`;

  let out: string;
  let hostKey: string | null;
  try {
    // See linux.ts's collectLinux for why this needs a bound — without it, a
    // target that goes unreachable mid-command hangs this poll (and this
    // target's polling) forever.
    const res = await sshExec(ctx, script, { execTimeoutMs: ctx.options.timeoutMs ?? 15_000 });
    out = res.stdout;
    hostKey = res.hostKey;
  } catch (err) {
    return { ...emptyResult((err as Error).message), hostKey: ctx.knownHostKey };
  }

  const blocks = splitSections(out);
  const metrics: Record<string, unknown> = {};

  // ---- CPU: average LoadPercentage across sockets (0–100) ----
  const cpuRaw = sectionFirst(blocks, "M_CPU");
  const cpuPct = cpuRaw !== "" && Number.isFinite(Number(cpuRaw)) ? Number(cpuRaw) : null;
  metrics.cpu = { totalPct: cpuPct, perCore: {} };

  // ---- Memory: TotalVisibleMemorySize / FreePhysicalMemory are in KB ----
  const memLines = sectionLines(blocks, "M_MEM").filter((l) => l.trim() !== "");
  const totalKb = Number(memLines[0]) || 0;
  const freeKb = Number(memLines[1]) || 0;
  const totalBytes = totalKb * 1024;
  const usedBytes = Math.max(0, (totalKb - freeKb) * 1024);
  let memPct: number | null = null;
  if (totalKb > 0) memPct = Math.max(0, Math.min(100, ((totalKb - freeKb) / totalKb) * 100));
  metrics.memory = {
    totalBytes,
    usedBytes,
    availableBytes: freeKb * 1024,
    usedPct: memPct,
  };

  // ---- Uptime (seconds) ----
  const up = Number(sectionFirst(blocks, "M_UP"));
  metrics.uptimeSec = Number.isFinite(up) && up > 0 ? up : null;

  // ---- Fixed disks: "C: <sizeBytes> <freeBytes>" ----
  const filesystems: Array<{ mount: string; sizeBytes: number; usedBytes: number; pct: number; ignored: boolean }> =
    [];
  let diskPctMax: number | null = null;
  for (const l of sectionLines(blocks, "M_DISK")) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const mount = parts[0]!;
    const size = Number(parts[1]);
    const free = Number(parts[2]);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(free)) continue;
    const used = Math.max(0, size - free);
    const pct = Math.round((used / size) * 1000) / 10;
    const ignored = isIgnoredMount(ctx, mount);
    filesystems.push({ mount, sizeBytes: size, usedBytes: used, pct, ignored });
    if (!ignored && (diskPctMax === null || pct > diskPctMax)) diskPctMax = pct;
  }
  metrics.filesystems = filesystems;

  // ---- Watched services ----
  const svcLines = sectionLines(blocks, "M_SVC");
  const services = watchedServices.map((name, i) => {
    const status = (svcLines[i] ?? "").trim() || "unknown";
    return { name, active: status === "Running", status };
  });
  metrics.services = services;
  metrics.servicesDownCount = services.filter((s) => !s.active).length;

  return {
    ok: true,
    hostKey,
    target: { cpuPct, memPct, diskPctMax, metrics },
    entities: [],
  };
}
