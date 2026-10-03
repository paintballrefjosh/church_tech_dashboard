import { sshExec } from "./ssh";
import { splitSections, sectionLines } from "./markers";
import { type CollectContext, type CollectResult, emptyResult } from "./types";

/**
 * OS package-update check. A separate, opt-in SSH round-trip (gated behind
 * the `updates` capability in dispatch.ts) rather than folded into the base
 * cpu/mem/disk script — unlike those, this reads package-manager state that
 * varies a lot in cost across OSes (Linux: free, just reads a local cache;
 * macOS/Windows: hit their own update service each call), so it shouldn't run
 * on every poll of every host by default. Mirrors collectDocker's shape.
 *
 * Linux never runs `apt-get update` / refreshes any repo metadata itself — it
 * only reads whatever cache the box's own unattended-upgrades/cron already
 * populated (same convention as tools like apticron / check_apt). A stale
 * cache under-reports; that's expected, not a bug.
 */
export async function collectUpdates(ctx: CollectContext, os: string): Promise<CollectResult> {
  const script = os === "mac" ? MAC_SCRIPT : os === "windows" ? WINDOWS_SCRIPT : LINUX_SCRIPT;
  // See collectors/linux.ts's collectLinux for why this needs a bound at
  // all — without one, a target that goes unreachable mid-command hangs
  // this poll (and this target's polling) forever. The default is OS-aware
  // rather than reusing the flat 15s connect-handshake fallback other
  // collectors use: WINDOWS_SCRIPT has its own internal `Wait-Job -Timeout
  // 60`, so anything under ~65s would cut it off before its own budget
  // even elapses; MAC_SCRIPT hits Apple's live update service with no
  // fixed bound of its own.
  const defaultExecTimeoutMs = os === "windows" ? 70_000 : os === "mac" ? 45_000 : 15_000;
  let out: string;
  let hostKey: string | null;
  try {
    const res = await sshExec(ctx, script, { execTimeoutMs: ctx.options.timeoutMs ?? defaultExecTimeoutMs });
    out = res.stdout;
    hostKey = res.hostKey;
  } catch (err) {
    return { ...emptyResult((err as Error).message), hostKey: ctx.knownHostKey };
  }

  const blocks = splitSections(out);
  const updLines = sectionLines(blocks, "M_UPD").map((l) => l.trim()).filter((l) => l !== "");
  const rebootLine = sectionLines(blocks, "M_REBOOT").map((l) => l.trim()).find((l) => l !== "") ?? "0";

  const packageManager = updLines[0] ?? null;
  const count = parseCount(updLines[1]);
  const securityCount = parseCount(updLines[2]);

  const metrics = {
    updates: {
      packageManager: packageManager && packageManager !== "unknown" ? packageManager : null,
      count,
      securityCount,
      // Kept numeric (0/1, not boolean) so it composes with the existing
      // dotted-metric-path threshold rules (resolveMetric only accepts numbers).
      rebootRequired: rebootLine === "1" ? 1 : 0,
    },
  };

  return {
    ok: true,
    hostKey,
    target: { cpuPct: null, memPct: null, diskPctMax: null, metrics },
    entities: [],
  };
}

/** "-1" is this module's own sentinel for "couldn't determine" (timeout/error/unsupported). */
function parseCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ---- Linux: detect the package manager, read its (already-cached) upgrade
// list — no network refresh — plus the distro's own reboot-required marker.
const LINUX_SCRIPT = [
  "echo M_UPD",
  [
    "if command -v apt-get >/dev/null 2>&1; then",
    "  echo apt",
    '  APT_OUT="$(apt list --upgradable 2>/dev/null | tail -n +2)"',
    // `apt list --upgradable` lists every package with a newer candidate,
    // including ones still in Ubuntu/Debian's phased rollout window that a
    // plain `apt-get upgrade` won't actually touch yet (it correctly defers
    // them — see infra-updater.ts's includePhased). Counting those as
    // "available" overstates what's really actionable right now, so exclude
    // them: `--simulate` is a safe, unprivileged dry-run (no lock taken, no
    // changes made) that reports exactly which packages are being deferred
    // for phasing, by name.
    '  PHASED="$(apt-get upgrade --simulate 2>/dev/null | awk \'/deferred due to phasing/{f=1;next} f && /^ /{sub(/^[ \\t]+/,"");print;next} {f=0}\')"',
    '  if [ -n "$PHASED" ]; then',
    // Package names can be space-separated across one or more indented
    // lines (apt wraps long lists), so split on any run of spaces/newlines,
    // not just newlines, before building the exclusion set.
    '    APT_OUT="$(echo "$APT_OUT" | awk -F/ -v phased="$PHASED" \'BEGIN{n=split(phased,arr,/[ \\n]+/);for(i=1;i<=n;i++)if(arr[i]!="")skip[arr[i]]=1} !($1 in skip)\')"',
    "  fi",
    '  echo "$APT_OUT" | grep -c .',
    '  echo "$APT_OUT" | grep -c -- \'-security\'',
    "elif command -v dnf >/dev/null 2>&1; then",
    "  echo dnf",
    "  dnf -q check-update 2>/dev/null | grep -c '^[A-Za-z0-9]'",
    "  dnf -q check-update --security 2>/dev/null | grep -c '^[A-Za-z0-9]'",
    "elif command -v yum >/dev/null 2>&1; then",
    "  echo yum",
    "  yum -q check-update 2>/dev/null | grep -c '^[A-Za-z0-9]'",
    "  yum -q check-update --security 2>/dev/null | grep -c '^[A-Za-z0-9]'",
    "elif command -v zypper >/dev/null 2>&1; then",
    "  echo zypper",
    "  zypper -q lu 2>/dev/null | grep -c '^v '",
    "  echo 0",
    "elif command -v pacman >/dev/null 2>&1; then",
    "  echo pacman",
    "  pacman -Qu 2>/dev/null | grep -c .",
    "  echo 0",
    "elif command -v apk >/dev/null 2>&1; then",
    "  echo apk",
    "  apk list -u 2>/dev/null | grep -c .",
    "  echo 0",
    "else",
    "  echo unknown",
    "  echo 0",
    "  echo 0",
    "fi",
  ].join("\n"),
  "echo M_REBOOT",
  [
    "if [ -f /var/run/reboot-required ]; then",
    "  echo 1",
    "elif command -v needs-restarting >/dev/null 2>&1; then",
    "  needs-restarting -r >/dev/null 2>&1",
    '  [ "$?" = "1" ] && echo 1 || echo 0',
    "else",
    "  echo 0",
    "fi",
  ].join("\n"),
].join("\n");

// ---- macOS: `softwareupdate -l` hits Apple's update service every call (no
// local-cache-only mode exists), so this is genuinely slower than the Linux
// path — expected, and why this whole check is opt-in per target.
const MAC_SCRIPT = [
  'SU_OUT="$(softwareupdate -l 2>&1)"',
  "echo M_UPD",
  "echo softwareupdate",
  'echo "$SU_OUT" | grep -c \'^[[:space:]]*\\* Label:\'',
  'echo "$SU_OUT" | grep -c \'restart\'',
  "echo M_REBOOT",
  'echo "$SU_OUT" | grep -qi \'restart\' && echo 1 || echo 0',
].join("\n");

// ---- Windows: the only reliable "updates available" source without an
// extra module (PSWindowsUpdate isn't built in) is the Windows Update Agent
// COM API, which can be slow on a cold search — run it in a background job
// with a hard Wait-Job timeout so a slow host degrades to "unknown" instead
// of stalling this target's polling indefinitely (sshExec has no exec-level
// timeout of its own). The reboot-pending registry check is cheap/reliable
// and always runs regardless of how the update search went.
const WINDOWS_PS = [
  "Write-Output 'M_UPD'",
  "Write-Output 'wuauclt'",
  "$job = Start-Job -ScriptBlock { try { $s = New-Object -ComObject Microsoft.Update.Session; $r = $s.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0'); $sec = 0; foreach ($u in $r.Updates) { if ($u.MsrcSeverity) { $sec++ } }; Write-Output $r.Updates.Count; Write-Output $sec } catch { Write-Output -1; Write-Output -1 } }",
  "if (Wait-Job $job -Timeout 60) { Receive-Job $job } else { Stop-Job $job; Write-Output -1; Write-Output -1 }",
  "Remove-Job $job -Force -ErrorAction SilentlyContinue",
  "Write-Output 'M_REBOOT'",
  "$rb1 = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'",
  "$rb2 = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'",
  "if ($rb1 -or $rb2) { Write-Output 1 } else { Write-Output 0 }",
].join("; ");
const WINDOWS_SCRIPT = `powershell -NoProfile -NonInteractive -Command "${WINDOWS_PS}"`;
