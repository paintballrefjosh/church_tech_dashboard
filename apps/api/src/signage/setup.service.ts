import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  SIGNAGE_KEYS,
  canonicalJson,
  createSignageScreenSchema,
  loginUserFor,
  type SignageApplyConfig,
  type SignageRunKind,
  type SignageRunStatus,
  type SignageSetupInput,
  type SignageSetupRun,
} from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { signageDevices, signageFound, signageSetupRuns } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { decryptSecret, encryptSecret } from "../settings/crypto";
import { SignageService } from "./signage.service";
import { CtlError, SignageDevices, type DeviceRow } from "./devices.service";
import { PiSession, PiSshError, parseSshConnection, type PiLogin } from "./pi-ssh";
import { signageKey } from "./ssh-key";
import type { AgentBundle } from "./agent-bundle";
import { SignageReleases } from "./releases.service";

type RunRow = typeof signageSetupRuns.$inferSelect;

/** A run holds its row this long and renews it while it works; a dead node's run is taken over after it lapses. */
const CLAIM_MIN = 15;
const MAX_PARALLEL = 4;
const BUNDLE_TMP = "/tmp/lampstand-signage-agent.tgz";

interface RunSecrets {
  username?: string;
  password?: string;
  sudoPassword?: string;
}

class NeedsSudo extends Error {}

/** One running setup/apply/update, with its live log written back to the row about once a second. */
class RunLog {
  private buf = "";
  private dirty = false;
  private timer: NodeJS.Timeout;
  constructor(
    private readonly db: Db,
    private readonly id: string,
    private readonly secrets: string[],
  ) {
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }
  scrub(text: string): string {
    let t = text;
    for (const s of this.secrets) if (s) t = t.split(s).join("[hidden]");
    return t;
  }
  line(text: string): void {
    this.buf += this.scrub(text.endsWith("\n") ? text : `${text}\n`);
    if (this.buf.length > 400_000) this.buf = this.buf.slice(-300_000);
    this.dirty = true;
  }
  /** Pi-side progress (`@@step <name>` lines become the run's current step). */
  stderr = (chunk: string): void => {
    for (const l of chunk.split("\n")) {
      if (!l) continue;
      const m = /^@@step (\S+)/.exec(l);
      if (m) void this.step(m[1]!);
      else this.line(`  ${l}`);
    }
  };
  async step(name: string): Promise<void> {
    this.line(`== ${name}`);
    await this.db.update(signageSetupRuns).set({ step: name }).where(eq(signageSetupRuns.id, this.id));
  }
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await this.db
      .update(signageSetupRuns)
      .set({ output: this.buf, claimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` })
      .where(eq(signageSetupRuns.id, this.id))
      .catch(() => undefined);
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.dirty = true;
    await this.flush();
  }
}

/**
 * Setup runs (docs/signage.md section 3): "Set up", "Apply again", agent and OS updates, each a row with a live log.
 * The `signage-setup` job runs queued rows, at most four at once and one per device, each CLAIMED with `claimed_until`.
 *
 * Setup logs in with the Imager account (password), copies the agent, and runs `signage-ctl apply` as root. The SSH and
 * firewall part of apply undoes itself after 120 s unless a SECOND login with the dashboard's key and the new rules runs
 * `signage-ctl confirm`: a change that would lock the dashboard out is never kept.
 */
@Injectable()
export class SignageSetup implements OnModuleInit {
  private readonly running = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
    private readonly content: SignageService,
    private readonly devices: SignageDevices,
    private readonly releases: SignageReleases,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "signage-setup", everyMs: 3_000, initialDelayMs: 15_000, run: () => this.tick() });
  }

  // ------------------------------------------------------------ queueing

  async dto(r: RunRow, names?: Map<string, string>): Promise<SignageSetupRun> {
    let name = names?.get(r.deviceId ?? "") ?? null;
    if (!names && r.deviceId) name = (await this.db.select({ n: signageDevices.name }).from(signageDevices).where(eq(signageDevices.id, r.deviceId)))[0]?.n ?? null;
    return {
      id: r.id,
      deviceId: r.deviceId,
      deviceName: name,
      ip: r.ip,
      kind: r.kind as SignageRunKind,
      status: r.status as SignageRunStatus,
      step: r.step,
      output: r.output,
      error: r.error,
      startedBy: r.startedBy,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }

  async list(deviceId: string | null, limit = 30): Promise<SignageSetupRun[]> {
    const rows = await this.devices.runsFor(deviceId, limit);
    const ids = [...new Set(rows.map((r) => r.deviceId).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await this.db.select({ id: signageDevices.id, name: signageDevices.name }).from(signageDevices).where(inArray(signageDevices.id, ids)) : []).map((d) => [d.id, d.name]));
    return Promise.all(rows.map((r) => this.dto(r, names)));
  }

  async get(id: string): Promise<SignageSetupRun> {
    const [r] = await this.db.select().from(signageSetupRuns).where(eq(signageSetupRuns.id, id));
    if (!r) throw new NotFoundException("No such run");
    return this.dto(r);
  }

  private async openRun(deviceId: string): Promise<void> {
    const [open] = await this.db
      .select({ id: signageSetupRuns.id })
      .from(signageSetupRuns)
      .where(and(eq(signageSetupRuns.deviceId, deviceId), inArray(signageSetupRuns.status, ["queued", "running"])));
    if (open) throw new ConflictException("This Pi already has a run waiting or in progress.");
  }

  /** "Set up" on a found Pi (or again on a device). Creates the device (and a new screen) at once, then queues the run. */
  async setup(input: SignageSetupInput, userId: string | null): Promise<SignageSetupRun> {
    let device: DeviceRow;
    if (input.foundId) {
      const [f] = await this.db.select().from(signageFound).where(eq(signageFound.id, input.foundId));
      if (!f) throw new NotFoundException("That Pi is no longer in the found list. Scan again.");
      if (!input.name) throw new BadRequestException("Give the device a name");
      const [known] = f.hostKey ? await this.db.select().from(signageDevices).where(eq(signageDevices.knownHostKey, f.hostKey)) : [];
      const screenId = await this.screenFor(input);
      if (known) {
        await this.openRun(known.id);
        [device] = await this.db.update(signageDevices).set({ ip: f.ip, name: input.name, ...(screenId !== undefined ? { screenId } : {}), status: "setting_up", updatedAt: new Date() }).where(eq(signageDevices.id, known.id)).returning() as [DeviceRow];
      } else {
        [device] = (await this.db.insert(signageDevices).values({ name: input.name, ip: f.ip, knownHostKey: f.hostKey, screenId: screenId ?? null, status: "setting_up" }).returning()) as [DeviceRow];
      }
    } else {
      device = await this.devices.row(input.deviceId!);
      await this.openRun(device.id);
      const screenId = await this.screenFor(input);
      await this.db.update(signageDevices).set({ ...(input.name ? { name: input.name } : {}), ...(screenId !== undefined ? { screenId } : {}), updatedAt: new Date() }).where(eq(signageDevices.id, device.id));
    }
    const secrets: RunSecrets = { username: input.username, password: input.password, sudoPassword: input.sudoPassword };
    const hasSecret = !!(secrets.username || secrets.password || secrets.sudoPassword);
    const [run] = await this.db
      .insert(signageSetupRuns)
      .values({ deviceId: device.id, ip: device.ip, kind: "setup", request: { foundId: input.foundId ?? null }, secretEnc: hasSecret ? encryptSecret(JSON.stringify(secrets)) : null, startedBy: userId })
      .returning();
    return this.dto(run!);
  }

  private async screenFor(input: SignageSetupInput): Promise<string | null | undefined> {
    if (input.newScreenName) {
      const parsed = createSignageScreenSchema.safeParse({ name: input.newScreenName });
      if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
      return (await this.content.createScreen(parsed.data)).id;
    }
    if (input.screenId) {
      await this.content.screenRow(input.screenId);
      const [taken] = await this.db.select({ id: signageDevices.id, name: signageDevices.name }).from(signageDevices).where(eq(signageDevices.screenId, input.screenId));
      if (taken && taken.id !== input.deviceId) throw new ConflictException(`${taken.name} already drives that screen.`);
      return input.screenId;
    }
    return input.screenId === null ? null : undefined;
  }

  /** Queue an apply / agent update / OS update on a set-up device. */
  async queue(deviceId: string, kind: Exclude<SignageRunKind, "setup" | "show_code">, userId: string | null, request: Record<string, unknown> = {}): Promise<SignageSetupRun> {
    const d = await this.devices.row(deviceId);
    if (d.status !== "active" && d.status !== "failed") throw new ConflictException("Set this Pi up first.");
    if (!d.loginUser) throw new ConflictException("This Pi was never set up: use Set up.");
    await this.openRun(d.id);
    const [run] = await this.db.insert(signageSetupRuns).values({ deviceId: d.id, ip: d.ip, kind, request, startedBy: userId }).returning();
    return this.dto(run!);
  }

  /** A run that stopped at "needs a sudo password": try again with one (never stored past the run). */
  async giveSudo(runId: string, sudoPassword: string): Promise<SignageSetupRun> {
    const [r] = await this.db.select().from(signageSetupRuns).where(eq(signageSetupRuns.id, runId));
    if (!r) throw new NotFoundException("No such run");
    if (r.status !== "needs_sudo") throw new ConflictException("This run is not waiting for a sudo password.");
    const prev: RunSecrets = r.secretEnc ? (JSON.parse(decryptSecret(r.secretEnc)) as RunSecrets) : {};
    await this.db
      .update(signageSetupRuns)
      .set({ status: "queued", error: null, secretEnc: encryptSecret(JSON.stringify({ ...prev, sudoPassword })), claimedUntil: null, finishedAt: null })
      .where(eq(signageSetupRuns.id, runId));
    return this.get(runId);
  }

  // ------------------------------------------------------------ the job

  async tick(): Promise<void> {
    if (this.running.size >= MAX_PARALLEL) return;
    const rows = await this.db
      .select()
      .from(signageSetupRuns)
      .where(or(eq(signageSetupRuns.status, "queued"), and(eq(signageSetupRuns.status, "running"), lt(signageSetupRuns.claimedUntil, sql`now()`))))
      .orderBy(asc(signageSetupRuns.createdAt))
      .limit(10);
    for (const r of rows) {
      if (this.running.size >= MAX_PARALLEL) break;
      if (r.deviceId && [...this.running].includes(r.deviceId)) continue;
      const [claimed] = await this.db
        .update(signageSetupRuns)
        .set({ status: "running", startedAt: r.startedAt ?? new Date(), claimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` })
        .where(and(eq(signageSetupRuns.id, r.id), or(eq(signageSetupRuns.status, "queued"), and(eq(signageSetupRuns.status, "running"), lt(signageSetupRuns.claimedUntil, sql`now()`)))))
        .returning();
      if (!claimed) continue;
      const key = claimed.deviceId ?? claimed.id;
      this.running.add(key);
      void this.execute(claimed, r.status === "running").finally(() => this.running.delete(key));
    }
  }

  private async finish(r: RunRow, status: SignageRunStatus, error: string | null, log: RunLog): Promise<void> {
    if (error) log.line(`!! ${error}`);
    log.line(status === "succeeded" ? "== finished" : `== ${status === "needs_sudo" ? "waiting for a sudo password" : "failed"}`);
    await log.close();
    await this.db
      .update(signageSetupRuns)
      .set({ status, error: error ? log.scrub(error).slice(0, 2000) : null, finishedAt: status === "needs_sudo" ? null : new Date(), claimedUntil: null, ...(status === "needs_sudo" ? {} : { secretEnc: null }) })
      .where(eq(signageSetupRuns.id, r.id));
  }

  /** `takenOver`: the run was another node's, which stopped while it ran (its claim lapsed). */
  async execute(r: RunRow, takenOver = false): Promise<void> {
    const secrets: RunSecrets = r.secretEnc ? (JSON.parse(decryptSecret(r.secretEnc)) as RunSecrets) : {};
    const saved = String((await this.settings.get(SIGNAGE_KEYS.setupPassword)) ?? "");
    const log = new RunLog(this.db, r.id, [secrets.password ?? "", secrets.sudoPassword ?? "", saved]);
    if (r.output) log.line(r.output.trimEnd() + (takenOver ? "\n(taken over from a node that stopped; starting again)" : "\n(starting again)"));
    try {
      const d = r.deviceId ? await this.devices.row(r.deviceId) : null;
      if (!d) throw new CtlError("The device was removed.");
      if (!d.enabled) throw new CtlError("The device is switched off in the dashboard.");
      switch (r.kind) {
        case "setup":
          await this.runSetup(d, secrets, saved, log);
          break;
        case "apply":
          await this.runApply(d, log, { rotate: r.request.rotate === true });
          break;
        case "agent_update":
          await this.withKey(d, log, async (s) => this.pushAgent(s, d, log, true));
          break;
        case "os_update":
          await this.withKey(d, log, async (s) => {
            const out = await SignageDevices.ctlOn(s, "os-update", [], { timeoutMs: 30_000 });
            log.line(out.started ? "OS update started on the Pi; it reports progress in its status (it may reboot twice)." : `not started: ${String(out.state ?? "")}`);
          });
          break;
        default:
          throw new CtlError(`Unknown run kind ${r.kind}`);
      }
      await this.finish(r, "succeeded", null, log);
    } catch (err) {
      if (err instanceof NeedsSudo) {
        await this.finish(r, "needs_sudo", err.message, log);
        return;
      }
      const msg = (err as Error).message;
      if (r.kind === "setup" && r.deviceId) {
        await this.db.update(signageDevices).set({ status: "failed", lastError: log.scrub(msg).slice(0, 500), updatedAt: new Date() }).where(and(eq(signageDevices.id, r.deviceId), eq(signageDevices.status, "setting_up")));
      }
      if (r.deviceId && err instanceof PiSshError) await this.devices.noteError(await this.devices.row(r.deviceId).catch(() => ({ id: r.deviceId }) as DeviceRow), err);
      await this.finish(r, "failed", msg, log);
    }
  }

  // ------------------------------------------------------------ flows

  private async withKey<T>(d: DeviceRow, log: RunLog, fn: (s: PiSession) => Promise<T>, generation?: number): Promise<T> {
    log.line(`connecting to ${d.loginUser}@${d.ip} with the dashboard's key`);
    const s = await PiSession.open(await this.devices.login(d, generation));
    try {
      await this.devices.pinIfUnpinned(d, s.hostKey);
      return await fn(s);
    } finally {
      s.close();
    }
  }

  private async currentRelease(): Promise<AgentBundle> {
    const rel = await this.releases.current();
    if (!rel) throw new CtlError("No agent release is available (the API image has no services/signage-agent).");
    return rel;
  }

  private async pushAgent(s: PiSession, d: DeviceRow, log: RunLog, force: boolean): Promise<void> {
    const rel = await this.currentRelease();
    if (!force && d.agentVersion === rel.version) return;
    log.line(`copying agent ${rel.version} (${Math.round(rel.bytes.length / 1024)} KB)`);
    const out = await SignageDevices.ctlOn(s, "agent-put", [rel.version, rel.sha256], { stdin: rel.bytes, timeoutMs: 120_000 });
    log.line(`agent ${String(out.installed)} installed${out.previous ? ` (was ${String(out.previous)})` : ""}`);
    await this.db.update(signageDevices).set({ agentVersion: rel.version }).where(eq(signageDevices.id, d.id));
  }

  /** The first setup (password login), or a repeat on a Pi the dashboard's key still opens. */
  private async runSetup(d: DeviceRow, secrets: RunSecrets, savedPassword: string, log: RunLog): Promise<void> {
    if (d.loginUser && d.keyGeneration) {
      try {
        await this.runApply(d, log, { rotate: false });
        return;
      } catch (err) {
        if (!(err instanceof PiSshError && err.kind === "auth")) throw err;
        log.line("the dashboard's key is not accepted: setting up again with the setup login");
      }
    }
    const username = secrets.username || String((await this.settings.get(SIGNAGE_KEYS.setupUsername)) ?? "") || "pi";
    const password = secrets.password || savedPassword;
    if (!password) throw new CtlError("No setup password: save one in Signage > Security settings, or type it for this Pi.");
    log.line(`connecting to ${username}@${d.ip} with the setup login`);
    await log.step("connect");
    const login: PiLogin = { host: d.ip, port: d.sshPort, username, password, knownHostKey: d.knownHostKey, timeoutMs: 15_000 };
    const s = await PiSession.open(login);
    let config: SignageApplyConfig;
    let token: string | null = null;
    let reboot = false;
    let applied: Record<string, unknown> = {};
    try {
      if (!d.knownHostKey && s.hostKey) {
        await this.db.update(signageDevices).set({ knownHostKey: s.hostKey }).where(eq(signageDevices.id, d.id));
        log.line(`host key pinned (SHA256:${s.hostKey.replace(/=+$/, "")})`);
      }
      const conn = (await s.exec('printf "%s\\n" "$SSH_CONNECTION"', { timeoutMs: 10_000 })).stdout.toString();
      const source = parseSshConnection(conn);
      const sources = [...new Set([...(d.dashboardSources ?? []), ...(source ? [`${source}/32`] : [])])].sort();
      // sudo: passwordless (Imager's default), or the password piped to `sudo -S` for each command.
      let sudo = "sudo -n";
      let sudoIn = "";
      if ((await s.exec("sudo -n true", { timeoutMs: 15_000 })).code !== 0) {
        const pw = secrets.sudoPassword || password;
        const r = await s.exec("sudo -S -p '' true", { stdin: `${pw}\n`, timeoutMs: 15_000 });
        if (r.code !== 0) throw new NeedsSudo(/not in the sudoers|not allowed/i.test(r.stderr) ? `${username} may not use sudo on this Pi: log in on the Pi and add it to the sudo group.` : "sudo asked for a password and the one given did not work: enter the sudo password for this Pi.");
        sudo = "sudo -S -p ''";
        sudoIn = `${pw}\n`;
      }
      await log.step("agent");
      const rel = await this.currentRelease();
      if (!/^\d+\.\d+\.\d+$/.test(rel.version) || !/^[0-9a-f]{64}$/.test(rel.sha256)) throw new CtlError("The agent release has a bad version or hash.");
      log.line(`copying agent ${rel.version}`);
      const up = await s.exec(`cat > ${BUNDLE_TMP} && sha256sum ${BUNDLE_TMP}`, { stdin: rel.bytes, timeoutMs: 120_000 });
      if (up.code !== 0 || !up.stdout.toString().startsWith(rel.sha256)) throw new CtlError(`Copying the agent failed: ${up.stderr.trim() || "the copy does not match"}`);
      const boot = await s.exec(
        `${sudo} sh -c 'set -e; d=/opt/signage/bootstrap; rm -rf "$d"; mkdir -p "$d"; tar -xzf ${BUNDLE_TMP} -C "$d"; python3 -I "$d/bin/signage-ctl" agent-install "$d" ${rel.version}; rm -rf "$d" ${BUNDLE_TMP}'`,
        { stdin: sudoIn, timeoutMs: 120_000 },
      );
      if (boot.code !== 0) throw new CtlError(`Installing the agent failed: ${(boot.stderr || boot.stdout.toString()).trim().slice(-500)}`);
      log.line("agent installed");
      await this.db.update(signageDevices).set({ setupUser: username, dashboardSources: sources, agentVersion: rel.version }).where(eq(signageDevices.id, d.id));
      d = { ...d, setupUser: username, dashboardSources: sources };
      config = await this.devices.applyConfig(d);
      const json = canonicalJson(config);
      log.line("applying the Signage settings (packages, accounts, system, SSH lock-down); this can take several minutes");
      const r = await s.exec(`${sudo} /usr/local/bin/signage-ctl apply`, { stdin: sudoIn + json, timeoutMs: 45 * 60_000, onStderr: log.stderr });
      applied = parseLast(r.stdout.toString());
      if (r.code !== 0 || applied.ok !== true) throw new CtlError(String(applied.error ?? (r.stderr.trim().slice(-500) || `apply exited ${r.code}`)));
      token = typeof applied.token === "string" ? applied.token : null;
      reboot = applied.reboot === true;
    } finally {
      s.close();
    }
    const gen = await this.devices.keyGeneration();
    await this.confirmAndRecord(d, config, gen, token, reboot, log);
    await this.db.delete(signageFound).where(eq(signageFound.ip, d.ip));
  }

  /** Apply again (and agent update when behind) with the dashboard's key; `rotate` moves the Pi to the current key. */
  async runApply(d: DeviceRow, log: RunLog, opts: { rotate: boolean }): Promise<void> {
    const gen = await this.devices.keyGeneration();
    const fromGen = d.keyGeneration ?? gen;
    const rotating = fromGen !== gen;
    const extra = rotating ? [signageKey(fromGen).publicKey] : [];
    if (rotating) log.line(`moving this Pi from key ${fromGen} to key ${gen}`);
    let config: SignageApplyConfig = await this.devices.applyConfig(d, extra);
    let token: string | null = null;
    let reboot = false;
    await this.withKey(
      d,
      log,
      async (s) => {
        const hello = await SignageDevices.ctlOn(s, "hello", [], { timeoutMs: 15_000 });
        const source = parseSshConnection(String(hello.sshConnection ?? ""));
        if (source && !(d.dashboardSources ?? []).includes(`${source}/32`)) {
          const sources = [...(d.dashboardSources ?? []), `${source}/32`].sort();
          await this.db.update(signageDevices).set({ dashboardSources: sources }).where(eq(signageDevices.id, d.id));
          d = { ...d, dashboardSources: sources };
          config = await this.devices.applyConfig(d, extra);
        }
        await this.pushAgent(s, d, log, false);
        log.line("applying the Signage settings");
        const out = await SignageDevices.ctlOn(s, "apply", [], { stdin: canonicalJson(config), timeoutMs: 45 * 60_000, onStderr: log.stderr });
        if (out.ok !== true) throw new CtlError(String(out.error ?? "apply failed"));
        token = typeof out.token === "string" ? out.token : null;
        reboot = out.reboot === true;
      },
      fromGen,
    );
    await this.confirmAndRecord(d, config, gen, token, reboot, log);
    if (rotating || opts.rotate) {
      // The old key is still listed: take it out now that the new one is proven.
      const fresh = await this.devices.row(d.id);
      if (rotating) await this.runApply(fresh, log, { rotate: false });
    }
  }

  /** The second login: the dashboard's key, the new rules. Only this keeps the change (else the Pi undoes it in 2 min). */
  private async confirmAndRecord(d: DeviceRow, config: SignageApplyConfig, gen: number, token: string | null, reboot: boolean, log: RunLog): Promise<void> {
    await log.step("verify");
    const loginUser = loginUserFor(config);
    const key = signageKey(gen);
    log.line(`logging in again as ${loginUser} with the dashboard's key`);
    let s: PiSession;
    try {
      s = await PiSession.open({ host: d.ip, port: d.sshPort, username: loginUser, privateKey: key.privateKey, knownHostKey: (await this.devices.row(d.id)).knownHostKey, timeoutMs: 15_000 });
    } catch (err) {
      throw new CtlError(`The dashboard could not log in with its key after the change (${(err as Error).message}). The Pi puts its previous SSH settings back within 2 minutes; check "Only the dashboard may connect" and the extra addresses in Security settings.`);
    }
    try {
      if (token) {
        const c = await SignageDevices.ctlOn(s, "confirm", [token], { timeoutMs: 30_000 });
        if (c.confirmed !== true) throw new CtlError(String(c.error ?? "the Pi did not accept the confirmation"));
        for (const line of (c.done as string[] | undefined) ?? []) log.line(line);
        log.line("SSH settings kept");
      }
      const hello = await SignageDevices.ctlOn(s, "hello", [], { timeoutMs: 15_000 });
      const st = await SignageDevices.ctlOn(s, "status", [], { timeoutMs: 60_000 });
      const macs = (hello.macs ?? {}) as { eth?: string | null; wlan?: string | null };
      await this.db
        .update(signageDevices)
        .set({
          loginUser,
          keyGeneration: gen,
          appliedSettingsHash: createHash("sha256").update(canonicalJson(config)).digest("hex"),
          status: "active",
          hostKeyMismatch: false,
          macEth: macs.eth ?? null,
          macWlan: macs.wlan ?? null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(signageDevices.id, d.id));
      await this.devices.recordStatus(await this.devices.row(d.id), st);
      if (reboot) {
        log.line("rebooting for the boot settings to take effect");
        await SignageDevices.ctlOn(s, "reboot", [], { timeoutMs: 15_000 }).catch(() => undefined);
      }
    } finally {
      s.close();
    }
    if (d.screenId) await this.content.markDirty([d.screenId]);
  }
}

function parseLast(text: string): Record<string, unknown> {
  const line = text.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { error: line.slice(-500) || "no answer" };
  }
}
