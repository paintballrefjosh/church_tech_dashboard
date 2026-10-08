import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { and, desc, eq, isNull, notInArray, or } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { infraTargets, infraUpdateRuns, users } from "../db/schema";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivityService } from "../activity/activity.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NodeService } from "../cluster/node.service";
import { InfraService } from "./infra.service";
import { InfraCollector } from "./infra-collector";
import { sshExec } from "./collectors/ssh";
import { splitSections, sectionLines } from "./collectors/markers";
import type { CollectContext } from "./collectors/types";
import {
  parseSetupResult,
  parseSudoProbe,
  scrubSecret,
  sudoProbeScript,
  sudoersFileFor,
  sudoersSetupScript,
  validSudoUser,
} from "./sudo-access";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import type { CreateInfraUpdateRunInput, InfraUpdateRun } from "@church/shared";

// A real fleet upgrade (apt-get update + upgrade across however many
// packages) can legitimately run long, especially the first time in a while
// or over a slow link — but it must still end. sshExec's execTimeoutMs (see
// collectors/ssh.ts) guarantees this side gives up and marks the run
// "timed_out" rather than sitting "running" forever; it does not stop the
// remote process.
const UPGRADE_TIMEOUT_MS = 30 * 60_000;
const REBOOT_TIMEOUT_MS = 15_000;
const SETUP_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 32_000;

/** A run that stopped before changing anything because of how sudo answered. */
interface SudoBlock {
  status: "needs_sudo" | "sudo_denied" | "failed";
  error: string;
  /** What sudo itself said (its prompt or refusal), shown to the operator as terminal output. */
  output: string;
}

/** Turns a failed sudo probe into the status, message and terminal text the operator is shown. */
function sudoBlock(
  user: string,
  state: "needs_password" | "bad_password" | "denied" | "no_sudo" | "root" | "ok",
  said: string,
  inSudoGroup: boolean,
  passwordTried: boolean,
): SudoBlock {
  switch (state) {
    case "denied":
      return {
        status: "sudo_denied",
        error:
          `sudo will not let "${user}" run commands as root on this host (it is not in the sudoers file). ` +
          `The dashboard cannot fix this itself. As root on the host, add the login to the sudo group ` +
          `("usermod -aG sudo ${user}" on Debian/Ubuntu, "usermod -aG wheel ${user}" on RHEL/Fedora) or give it a sudoers rule, ` +
          `then run the update again.` +
          (inSudoGroup ? "" : ` The login is in none of sudo, wheel or admin.`),
        output: said || `sudo: ${user} is not in the sudoers file.`,
      };
    case "bad_password":
      return {
        status: "needs_sudo",
        error: passwordTried ? `sudo did not accept that password for "${user}".` : `sudo needs a password for "${user}".`,
        output: said || "sudo: incorrect password attempt",
      };
    case "no_sudo":
      return {
        status: "failed",
        error: `"${user}" is not root and sudo is not installed on this host, so updates cannot be run. Log in as root or install sudo.`,
        output: said,
      };
    default:
      return {
        status: "needs_sudo",
        error:
          `sudo needs a password for "${user}" and none is stored for this SSH key login. ` +
          `Enter it to run this update once, or let the dashboard enable passwordless sudo for the login.` +
          (inSudoGroup ? "" : ` Note: the login is in none of sudo, wheel or admin, so sudo may refuse it.`),
        output: said || "sudo: a password is required",
      };
  }
}

@Injectable()
export class InfraUpdaterService implements OnModuleInit {
  private readonly logger = new Logger(InfraUpdaterService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly infra: InfraService,
    private readonly collector: InfraCollector,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly jobs: ClusterJobs,
    private readonly node: NodeService,
  ) {}

  /**
   * A run's status only ever gets written by the same process that started
   * it (execute() at the end of infra-updater.ts). If the api process dies
   * or is redeployed mid-run — a real production case (crash, OOM, a
   * deploy), not just a dev-loop artifact — that row is orphaned at
   * status='running' forever: nothing else will ever move it, and it also
   * permanently blocks start()'s one-run-per-target check for that host.
   * Since a freshly-started process has no in-flight runs of its own yet,
   * any row this node (or a pre-cluster install) left "running" at boot must be
   * exactly this — reconcile them once at startup rather than letting them
   * accumulate.
   *
   * With several nodes, "running" rows owned by *another live node* are that
   * node's business and are left alone. Rows owned by a node that has gone are
   * reconciled by a cluster job (`infra-update-reconcile`), since the node that
   * died is not around to do it at boot.
   */
  async onModuleInit(): Promise<void> {
    // Non-fatal: before the migration that adds node_id has run, this query fails,
    // and that must not stop the API from starting.
    await this.failOrphans(
      or(eq(infraUpdateRuns.nodeId, this.node.identity.nodeId), isNull(infraUpdateRuns.nodeId)),
      "Run was interrupted by a server restart before it could finish — unknown outcome on the host.",
    ).catch((err: unknown) => this.logger.warn(`boot reconcile of update runs failed: ${(err as Error).message}`));
    this.jobs.register({
      name: "infra-update-reconcile",
      everyMs: 60_000,
      initialDelayMs: 90_000,
      run: async () => {
        const live = new Set(await this.node.liveNodeIds());
        live.add(this.node.identity.nodeId);
        await this.failOrphans(
          and(notInArray(infraUpdateRuns.nodeId, [...live])),
          "The node running this update stopped before it finished — unknown outcome on the host.",
        );
      },
    });
  }

  private async failOrphans(where: ReturnType<typeof or>, error: string): Promise<void> {
    const orphaned = await this.db
      .update(infraUpdateRuns)
      .set({ status: "failed", error, finishedAt: new Date() })
      .where(and(eq(infraUpdateRuns.status, "running"), where))
      .returning({ id: infraUpdateRuns.id });
    if (orphaned.length) {
      this.logger.warn(`reconciled ${orphaned.length} update run(s) orphaned by a previous process lifetime`);
    }
  }

  async listRuns(targetId: string): Promise<InfraUpdateRun[]> {
    const rows = await this.db
      .select({ run: infraUpdateRuns, triggeredByName: users.name, triggeredByEmail: users.email })
      .from(infraUpdateRuns)
      .leftJoin(users, eq(users.id, infraUpdateRuns.triggeredByUserId))
      .where(eq(infraUpdateRuns.targetId, targetId))
      .orderBy(desc(infraUpdateRuns.startedAt))
      .limit(10);
    return rows.map((r) => toRun(r.run, r.triggeredByName ?? r.triggeredByEmail ?? null));
  }

  /**
   * Kicks off a run and returns immediately once the row is created —
   * the upgrade itself happens in the background (execute() is deliberately
   * not awaited). The controller's @Audited decorator records who triggered
   * this and when regardless of how the run turns out.
   */
  async start(targetId: string, user: AuthenticatedUser, input: CreateInfraUpdateRunInput): Promise<InfraUpdateRun> {
    const { reboot, fullUpgrade, includePhased } = input;
    const [target] = await this.db.select().from(infraTargets).where(eq(infraTargets.id, targetId)).limit(1);
    if (!target) throw new NotFoundException("Infrastructure target not found");

    // Linux-only for now: the read-only check (infra/collectors/updates.ts)
    // also covers mac/windows, but an unattended WRITE path (running package
    // upgrades, possibly followed by a reboot) needs a real host to validate
    // against, and this deployment's fleet is entirely Linux. Extending to
    // mac/windows is future work, not a silent best-effort fallback here.
    if (target.os !== "linux") {
      throw new BadRequestException(`Running updates isn't supported for ${target.os} hosts yet`);
    }
    if (!(target.capabilities as string[]).includes("updates")) {
      throw new BadRequestException('Enable the "OS updates" capability on this target first');
    }

    const [existingRunning] = await this.db
      .select({ id: infraUpdateRuns.id })
      .from(infraUpdateRuns)
      .where(and(eq(infraUpdateRuns.targetId, targetId), eq(infraUpdateRuns.status, "running")))
      .limit(1);
    if (existingRunning) throw new ConflictException("An update is already running on this host");

    const [run] = await this.db
      .insert(infraUpdateRuns)
      .values({ targetId, triggeredByUserId: user.id, rebootRequested: reboot, fullUpgrade, includePhased, nodeId: this.node.identity.nodeId })
      .returning();
    if (!run) throw new Error("Insert failed");

    // The sudo password lives only in this call chain: it is not written to the run row or logged.
    const sudo = { password: input.sudoPassword ?? null, enable: input.enablePasswordlessSudo };
    void this.execute(run.id, target, reboot, fullUpgrade, includePhased, sudo).catch((err) => {
      this.logger.error(`update run ${run.id} on ${target.name} crashed: ${(err as Error).message}`);
    });

    return toRun(run, user.name ?? user.email);
  }

  private async execute(
    runId: string,
    target: typeof infraTargets.$inferSelect,
    rebootRequested: boolean,
    fullUpgrade: boolean,
    includePhased: boolean,
    sudo: { password: string | null; enable: boolean },
  ): Promise<void> {
    const credential = await this.infra.getCredential(target.id);
    const ctx: CollectContext = {
      targetId: target.id,
      host: target.host,
      options: (target.options as CollectContext["options"]) ?? {},
      credential,
      knownHostKey: target.knownHostKey ?? null,
      prev: null,
    };
    const loginUser = credential?.username ?? "root";

    // A password typed for this run wins; otherwise the stored SSH-login password doubles as the sudo password
    // when the host has no NOPASSWD rule. It is fed to `sudo -S` over stdin (see ssh.ts), never argv. A key-auth
    // host with nothing typed has nothing to feed: the probe then stops the run as `needs_sudo` so the UI can ask.
    const sudoPassword = sudo.password ?? (credential?.authType === "ssh_password" ? credential.secret : null);
    const havePassword = Boolean(sudoPassword);
    const clean = (text: string) => scrubSecret(text, sudoPassword);

    let packageManager: string | null = null;
    let exitCode: number | null = null;
    let output = "";
    let rebootRequired = false;
    let rebootTriggered = false;
    let status: Exclude<InfraUpdateRun["status"], "running"> = "failed";
    let error: string | null = null;
    let sudoEnabled = false;

    try {
      let blocked: SudoBlock | null = null;

      if (sudo.enable) {
        const setup = await this.enablePasswordlessSudo(ctx, loginUser, sudoPassword);
        if (setup.blocked) blocked = setup.blocked;
        else sudoEnabled = setup.enabled;
      }

      if (!blocked) {
        const res = await sshExec(ctx, upgradeScript(havePassword, fullUpgrade, includePhased), {
          execTimeoutMs: UPGRADE_TIMEOUT_MS,
          stdin: sudoPassword ? `${sudoPassword}\n` : undefined,
        });
        const blocks = splitSections(res.stdout);
        const probe = parseSudoProbe(sectionLines(blocks, "M_SUDO"));
        if (probe && probe.state !== "root" && probe.state !== "ok") {
          blocked = sudoBlock(loginUser, probe.state, probe.message, probe.inSudoGroup, havePassword);
        } else {
          const pm = (sectionLines(blocks, "M_PKGMGR")[0] ?? "").trim();
          packageManager = pm && pm !== "unknown" ? pm : null;
          output = [
            sectionLines(blocks, "M_UPGRADE").join("\n").trim(),
            res.stderr.trim() ? `--- stderr ---\n${res.stderr.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, MAX_OUTPUT_CHARS);
          exitCode = parseInt((sectionLines(blocks, "M_EXIT")[0] ?? "").trim(), 10);
          if (!Number.isFinite(exitCode)) exitCode = null;
          rebootRequired = (sectionLines(blocks, "M_REBOOT")[0] ?? "").trim() === "1";
          status = packageManager && exitCode === 0 ? "success" : "failed";
          if (!packageManager) error = "No supported package manager detected (apt/dnf/yum/zypper/pacman/apk)";
        }
      }

      if (blocked) {
        status = blocked.status;
        error = blocked.error;
        output = blocked.output;
      }
    } catch (err) {
      const msg = (err as Error).message;
      status = /timed out/i.test(msg) ? "timed_out" : "failed";
      error = msg;
    }
    output = clean(output);
    if (error) error = clean(error);
    if (sudoEnabled) {
      output = [`Passwordless sudo enabled for ${loginUser} (${sudoersFileFor(loginUser)}).`, output].filter(Boolean).join("\n\n");
    }

    if (status === "success" && rebootRequested && rebootRequired) {
      try {
        const rres = await sshExec(ctx, rebootScript(havePassword), {
          execTimeoutMs: REBOOT_TIMEOUT_MS,
          stdin: sudoPassword ? `${sudoPassword}\n` : undefined,
        });
        const blocks = splitSections(rres.stdout);
        rebootTriggered = (sectionLines(blocks, "M_REBOOTTRIGGERED")[0] ?? "").trim() === "1";
        // Always append this step's own output — not just on failure — so a
        // "why didn't it reboot" question is answerable from the run's log
        // instead of needing a code change to add visibility after the fact.
        const rebootLog = [rres.stdout.trim(), rres.stderr.trim() ? `--- stderr ---\n${rres.stderr.trim()}` : ""]
          .filter(Boolean)
          .join("\n\n");
        if (rebootLog) {
          output = [output, "--- reboot step ---", rebootLog].filter(Boolean).join("\n\n").slice(0, MAX_OUTPUT_CHARS);
        }
        if (!rebootTriggered) {
          error = "Upgrade succeeded, but reboot could not be triggered (no root / no passwordless sudo for reboot) — see the run log";
        }
      } catch (err) {
        error = `Upgrade succeeded, but the reboot command failed: ${(err as Error).message}`;
      }
    }

    const finishedAt = new Date();
    await this.db
      .update(infraUpdateRuns)
      .set({ status, packageManager, rebootRequired, rebootTriggered, exitCode, output, error, finishedAt })
      .where(eq(infraUpdateRuns.id, runId));

    const [run] = await this.db.select().from(infraUpdateRuns).where(eq(infraUpdateRuns.id, runId)).limit(1);

    const title =
      status === "success"
        ? `${target.name}: updates applied${rebootTriggered ? " (rebooting)" : ""}`
        : status === "needs_sudo"
          ? `${target.name}: updates need a sudo password`
          : status === "sudo_denied"
            ? `${target.name}: sudo refused ${loginUser}`
            : `${target.name}: update run ${status === "timed_out" ? "timed out" : "failed"}`;
    const body =
      status === "success"
        ? rebootRequired
          ? rebootTriggered
            ? "A reboot was needed and has been triggered."
            : "A reboot is needed but wasn't triggered (see the run log)."
          : "No reboot needed."
        : error ?? "See the run log for details.";
    await this.notify(target.id, run?.triggeredByUserId ?? null, title, body);
    await this.activity.record({
      actorUserId: run?.triggeredByUserId ?? null,
      action: status === "success" ? "infra.target.update_run.success" : "infra.target.update_run.failed",
      resourceType: "infra_target",
      resourceId: target.id,
      title,
      summary: body,
      link: `/monitoring/infra/${target.id}`,
    });

    // Best-effort: refresh the target's metrics right away so the "updates
    // available" badge reflects the new state without waiting on the next
    // scheduled tick. Never lets a poll failure mask the update run's own
    // outcome, which is already durably recorded above.
    if (status !== "needs_sudo" && status !== "sudo_denied") void this.collector.pollNow(target.id).catch(() => {});
  }

  /**
   * Writes the sudoers drop-in that gives the login passwordless sudo (see sudo-access.ts). A refusal comes back
   * as a `blocked` outcome for the run; success lets the upgrade carry on in the same run.
   */
  private async enablePasswordlessSudo(
    ctx: CollectContext,
    loginUser: string,
    password: string | null,
  ): Promise<{ enabled: boolean; blocked: SudoBlock | null }> {
    const fail = (error: string, output = ""): { enabled: false; blocked: SudoBlock } => ({
      enabled: false,
      blocked: { status: "failed", error, output },
    });
    if (!validSudoUser(loginUser)) {
      return fail(`Passwordless sudo cannot be set up for the login "${loginUser}" (root needs none; other names are limited to letters, digits, "_", "-" and ".").`);
    }
    const res = await sshExec(ctx, sudoersSetupScript(loginUser), {
      execTimeoutMs: SETUP_TIMEOUT_MS,
      stdin: password ? `${password}\n` : undefined,
    });
    const result = parseSetupResult(sectionLines(splitSections(res.stdout), "M_SETUP"));
    if (!result) return fail("The host gave no usable answer to the passwordless sudo setup", res.stderr.trim());
    const message = scrubSecret(result.message, password);
    switch (result.state) {
      case "ok":
        this.logger.log(`passwordless sudo enabled for ${loginUser} on ${ctx.host}`);
        return { enabled: true, blocked: null };
      case "already":
        return { enabled: false, blocked: null };
      case "denied":
        return { enabled: false, blocked: sudoBlock(loginUser, "denied", message, false, true) };
      case "bad_password":
        return { enabled: false, blocked: sudoBlock(loginUser, "bad_password", message, false, true) };
      case "no_sudo":
        return { enabled: false, blocked: sudoBlock(loginUser, "no_sudo", message, false, true) };
      default:
        return fail(`Could not enable passwordless sudo: ${message || result.state}`, message);
    }
  }

  private async notify(targetId: string, triggeredByUserId: string | null, title: string, body: string): Promise<void> {
    try {
      const recipientIds = new Set(await this.infra.monitoringRecipientIds());
      if (triggeredByUserId) recipientIds.add(triggeredByUserId);
      if (!recipientIds.size) return;
      await this.notifications.createMany(
        [...recipientIds].map((id) => ({
          recipientUserId: id,
          kind: "infra.update_run",
          title,
          body,
          link: `/monitoring/infra/${targetId}`,
        })),
      );
    } catch (err) {
      this.logger.warn(`update-run notification failed: ${(err as Error).message}`);
    }
  }
}

function toRun(row: typeof infraUpdateRuns.$inferSelect, triggeredByName: string | null): InfraUpdateRun {
  return {
    id: row.id,
    targetId: row.targetId,
    triggeredByUserId: row.triggeredByUserId,
    triggeredByName,
    status: row.status as InfraUpdateRun["status"],
    packageManager: row.packageManager,
    fullUpgrade: row.fullUpgrade,
    includePhased: row.includePhased,
    rebootRequested: row.rebootRequested,
    rebootRequired: row.rebootRequired,
    rebootTriggered: row.rebootTriggered,
    exitCode: row.exitCode,
    output: row.output,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

// ---- remote scripts ----
//
// Both env-prefix every privileged invocation with `$SUDO env ...` rather
// than `$SUDO ...` directly: sudo does not propagate arbitrary environment
// variables to the child process unless the sudoers config explicitly keeps
// them (rarely true by default), so `DEBIAN_FRONTEND=noninteractive sudo
// apt-get` would silently lose that variable under sudo and could still
// block on an interactive prompt. Routing through `env` makes the var-setting
// step the thing actually being sudo'd, so it works whether or not $SUDO is
// set. NEEDRESTART_MODE=a suppresses the interactive "which services should
// restart?" prompt that Debian/Ubuntu's needrestart package shows by default
// after a library upgrade — a common, easy-to-miss source of an apt upgrade
// silently hanging until it hits UPGRADE_TIMEOUT_MS.

function upgradeScript(havePassword: boolean, fullUpgrade: boolean, includePhased: boolean): string {
  // Plain `upgrade` never removes/replaces a package, so a kernel/dependency
  // -driven bump shows as "kept back" forever unless the operator opts into
  // `full-upgrade` (apt's modern spelling of dist-upgrade). Other package
  // managers' equivalent command already resolves this by default, so
  // `fullUpgrade` only changes the apt branch below.
  const aptUpgradeCmd = fullUpgrade ? "full-upgrade" : "upgrade";
  // Ubuntu/Debian phase certain package versions out to a percentage of
  // machines at a time (per machine-id) to catch regressions early — apt
  // correctly defers a package still in its phase-in window ("deferred due
  // to phasing"). This flag is the operator explicitly opting out of that
  // safety net for this run. Only meaningful for apt; other package
  // managers have no equivalent mechanism to bypass.
  const phasedFlag = includePhased ? " -o APT::Get::Always-Include-Phased-Updates=true" : "";
  return [
  "echo M_PKGMGR",
  [
    "PM=unknown",
    "if command -v apt-get >/dev/null 2>&1; then PM=apt",
    "elif command -v dnf >/dev/null 2>&1; then PM=dnf",
    "elif command -v yum >/dev/null 2>&1; then PM=yum",
    "elif command -v zypper >/dev/null 2>&1; then PM=zypper",
    "elif command -v pacman >/dev/null 2>&1; then PM=pacman",
    "elif command -v apk >/dev/null 2>&1; then PM=apk",
    "fi",
    "echo $PM",
  ].join("\n"),
  // Reports sudo's state and stops here when the run cannot go on (see sudo-access.ts).
  sudoProbeScript(havePassword),
  "echo M_UPGRADE",
  [
    'case "$PM" in',
    "  apt)",
    "    $SUDO env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y update 2>&1",
    `    $SUDO env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold${phasedFlag} ${aptUpgradeCmd} 2>&1`,
    "    ;;",
    "  dnf)",
    "    $SUDO env NEEDRESTART_MODE=a dnf -y upgrade 2>&1",
    "    ;;",
    "  yum)",
    "    $SUDO yum -y update 2>&1",
    "    ;;",
    "  zypper)",
    "    $SUDO zypper --non-interactive update 2>&1",
    "    ;;",
    "  pacman)",
    "    $SUDO pacman -Syu --noconfirm 2>&1",
    "    ;;",
    "  apk)",
    "    $SUDO apk upgrade 2>&1",
    "    ;;",
    "  *)",
    "    echo 'no supported package manager detected' >&2",
    "    ;;",
    "esac",
    // Capture immediately — `echo M_EXIT` below would otherwise overwrite $?
    // with its own (always-0) exit status before we get to read it.
    "UPGRADE_EXIT=$?",
  ].join("\n"),
  "echo M_EXIT",
  "echo $UPGRADE_EXIT",
  "echo M_REBOOT",
  [
    "if [ -f /var/run/reboot-required ]; then",
    "  echo 1",
    "elif command -v needs-restarting >/dev/null 2>&1; then",
    "  $SUDO needs-restarting -r >/dev/null 2>&1",
    '  [ "$?" = "1" ] && echo 1 || echo 0',
    "else",
    "  echo 0",
    "fi",
  ].join("\n"),
  ].join("\n");
}

// Uses `shutdown -r +1` (see history below) with the password, if any, fed
// straight to the SAME `sudo -S` invocation that runs it — no separate
// "prime the credential cache, then reuse it a moment later" step at all.
//
// History: v1 dispatched a backgrounded `nohup $SUDO sh -c 'sleep 2;
// reboot' &`; it echoed 1 (sudo really had authenticated) but never actually
// rebooted — the deferred `sudo -n`, re-evaluated 2s later inside that
// detached subshell, silently failed to reuse the ticket validated moments
// earlier. v2 switched to `shutdown` with the sudo probe's prime-then-reuse
// (`sudo -S -v` once, then `sudo -n` for the actual command) — the same
// pattern upgradeScript uses successfully across several `apt-get` calls —
// but on this host it *also* intermittently failed: `sudo -n` moments after
// a successful `-v` still came back "a password is required". Rather than
// chase exactly why sudo's cache didn't carry the few lines from -v to the
// next line here (this script only has the one privileged command anyway,
// so there's nothing to amortize a separate priming step over), this
// version removes the gap entirely: `sudo -n` is tried first (so a NOPASSWD
// host never touches the password), and only on failure does the password
// go straight to `sudo -S shutdown` in one shot.
function rebootScript(havePassword: boolean): string {
  return [
  "echo M_REBOOTTRIGGERED",
  [
    // The 1/0 flag is always the FIRST line under the marker (see
    // InfraUpdaterService.execute's parsing), computed from shutdown's own
    // real exit code; its message, if any, follows on later lines purely
    // for the run log.
    'if [ "$(id -u)" = "0" ]; then',
    "  SD_OUT=$(shutdown -r +1 2>&1)",
    "  [ $? -eq 0 ] && echo 1 || echo 0",
    "elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then",
    "  SD_OUT=$(sudo -n shutdown -r +1 2>&1)",
    "  [ $? -eq 0 ] && echo 1 || echo 0",
    havePassword ? 'elif command -v sudo >/dev/null 2>&1; then' : "else",
    havePassword ? "  SD_OUT=$(sudo -S shutdown -r +1 2>&1)" : '  SD_OUT=""',
    havePassword ? "  [ $? -eq 0 ] && echo 1 || echo 0" : "  echo 0",
    ...(havePassword ? ["else", '  SD_OUT=""', "  echo 0"] : []),
    "fi",
    'echo "$SD_OUT"',
  ].join("\n"),
  ].join("\n");
}
