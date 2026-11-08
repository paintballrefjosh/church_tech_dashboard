import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import {
  SIGNAGE_KEYS,
  buildApplyConfig,
  canonicalJson,
  deviceProblems,
  identifyCodes,
  isPrivateUnicast,
  manifestPowerAt,
  readSignageSecurity,
  signagePiStatusSchema,
  type SignageApplyConfig,
  type SignageCommandInput,
  type SignageCommandResult,
  type SignageDevice,
  type SignageDeviceStatus,
  type SignageIdentifyInput,
  type SignageIdentifyResult,
  type SignageKeyInfo,
  type SignagePiStatus,
} from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { signageDevices, signageScreens, signageScreenshots, signageStatusSamples, signageSetupRuns } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { SignageService } from "./signage.service";
import { SignageCompiler } from "./compiler.service";
import { SIGNAGE_ONLINE_MS } from "./constants";
import { signageKey, type SignageKeyPair } from "./ssh-key";
import { PiSession, PiSshError, withPi, type PiLogin } from "./pi-ssh";
import { bundledAgent, compareVersions } from "./agent-bundle";

export type DeviceRow = typeof signageDevices.$inferSelect;

/** Arguments to signage-ctl: only these characters, so a command line never needs quoting (the agent refuses others too). */
const ARG = /^[A-Za-z0-9._:=/+-]{1,500}$/;

export class CtlError extends Error {
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
  }
}

/**
 * Signage devices (docs/signage.md sections 4, 5): the Pis the dashboard set up, reached over SSH with the dashboard's
 * derived key. Every command is `signage-ctl <command> <args>`; the answer is one JSON object.
 */
@Injectable()
export class SignageDevices {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly content: SignageService,
    private readonly compiler: SignageCompiler,
  ) {}

  // ------------------------------------------------------------ keys and settings

  async keyGeneration(): Promise<number> {
    const g = Number(await this.settings.get(SIGNAGE_KEYS.keyGeneration));
    return Number.isInteger(g) && g >= 1 ? g : 1;
  }

  async currentKey(): Promise<SignageKeyPair> {
    return signageKey(await this.keyGeneration());
  }

  async keyInfo(): Promise<SignageKeyInfo> {
    const k = await this.currentKey();
    const rows = await this.db.select({ g: signageDevices.keyGeneration }).from(signageDevices).where(eq(signageDevices.status, "active"));
    return { generation: k.generation, publicKey: k.publicKey, fingerprint: k.fingerprint, devicesOnOldKey: rows.filter((r) => r.g !== k.generation).length };
  }

  async security() {
    const values = new Map<string, unknown>();
    for (const key of Object.values(SIGNAGE_KEYS)) values.set(key, await this.settings.get(key));
    return readSignageSecurity((k) => values.get(k));
  }

  /** The settings this device should have now. `extraKeys` carries an older key during a rotation. */
  async applyConfig(d: Pick<DeviceRow, "name" | "setupUser" | "dashboardSources">, extraKeys: string[] = []): Promise<SignageApplyConfig> {
    const [sec, tz, key] = await Promise.all([this.security(), this.content.zone(), this.currentKey()]);
    return buildApplyConfig(sec, {
      setupUser: d.setupUser ?? "pi",
      dashboardSources: d.dashboardSources ?? [],
      timezone: tz,
      deviceName: d.name,
      authorizedKeys: [key.publicKey, ...extraKeys.filter((k) => k !== key.publicKey)],
    });
  }

  static configHash(c: SignageApplyConfig): string {
    return createHash("sha256").update(canonicalJson(c)).digest("hex");
  }

  // ------------------------------------------------------------ SSH

  async login(d: DeviceRow, generation?: number): Promise<PiLogin> {
    if (d.hostKeyMismatch) throw new CtlError("Its SSH host key changed. Trust the new key on the device page first.");
    if (!d.loginUser) throw new CtlError("This Pi is not set up yet.");
    const key = signageKey(generation ?? d.keyGeneration ?? (await this.keyGeneration()));
    return { host: d.ip, port: d.sshPort, username: d.loginUser, privateKey: key.privateKey, knownHostKey: d.knownHostKey, timeoutMs: 10_000 };
  }

  /** Run one signage-ctl command on an open session. */
  static async ctlOn(s: PiSession, command: string, args: string[] = [], opts: { stdin?: Buffer | string | NodeJS.ReadableStream; timeoutMs?: number; onStderr?: (t: string) => void } = {}): Promise<Record<string, unknown>> {
    for (const a of [command, ...args]) if (!ARG.test(a)) throw new CtlError(`Not a safe argument: ${a.slice(0, 40)}`);
    const r = await s.exec(["signage-ctl", command, ...args].join(" "), { stdin: opts.stdin as never, timeoutMs: opts.timeoutMs, onStderr: opts.onStderr });
    const text = r.stdout.toString("utf8").trim().split("\n").pop() ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const why = (r.stderr || text).trim().slice(-300);
      if (r.code === 127 || /not found/.test(why)) throw new CtlError("signage-ctl is not installed on this Pi (set it up again).");
      throw new CtlError(`Unexpected answer from the Pi: ${why || `exit ${r.code}`}`);
    }
    if (r.code !== 0 || typeof body.error === "string") throw new CtlError(String(body.error ?? `exit ${r.code}`), body.refused === true);
    return body;
  }

  /** One command on a device, in its own session. Records that the device answered (or why not). */
  async ctl(d: DeviceRow, command: string, args: string[] = [], opts: { stdin?: Buffer | string | NodeJS.ReadableStream; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    try {
      const out = await withPi(await this.login(d), (s) => SignageDevices.ctlOn(s, command, args, opts));
      await this.db.update(signageDevices).set({ lastSeenAt: new Date(), lastError: null }).where(eq(signageDevices.id, d.id));
      return out;
    } catch (err) {
      await this.noteError(d, err);
      throw err;
    }
  }

  async noteError(d: DeviceRow, err: unknown): Promise<void> {
    const e = err as Error;
    if (err instanceof PiSshError && err.kind === "host_key") {
      await this.db.update(signageDevices).set({ hostKeyMismatch: true, lastError: e.message }).where(eq(signageDevices.id, d.id));
    } else if (err instanceof PiSshError) {
      await this.db.update(signageDevices).set({ lastError: e.message.slice(0, 500) }).where(eq(signageDevices.id, d.id));
    }
  }

  // ------------------------------------------------------------ reading

  async row(id: string): Promise<DeviceRow> {
    const [d] = await this.db.select().from(signageDevices).where(eq(signageDevices.id, id));
    if (!d) throw new NotFoundException("No such device");
    return d;
  }

  async list(): Promise<SignageDevice[]> {
    return this.dtos(await this.db.select().from(signageDevices).orderBy(signageDevices.name));
  }

  async get(id: string): Promise<SignageDevice> {
    return (await this.dtos([await this.row(id)]))[0]!;
  }

  async dtos(rows: DeviceRow[]): Promise<SignageDevice[]> {
    if (!rows.length) return [];
    const screenIds = rows.map((r) => r.screenId).filter((x): x is string => !!x);
    const [screens, manifests, gen] = await Promise.all([
      screenIds.length ? this.db.select({ id: signageScreens.id, name: signageScreens.name, version: signageScreens.manifestVersion }).from(signageScreens).where(inArray(signageScreens.id, screenIds)) : Promise.resolve([]),
      this.compiler.latestManifests(screenIds),
      this.keyGeneration(),
    ]);
    const byScreen = new Map(screens.map((s) => [s.id, s]));
    const current = bundledAgent()?.version ?? null;
    const now = new Date();
    const out: SignageDevice[] = [];
    for (const d of rows) {
      const s = d.screenId ? byScreen.get(d.screenId) : undefined;
      const m = d.screenId ? manifests.get(d.screenId) : undefined;
      const power = m ? manifestPowerAt(m, now) : null;
      const expected = d.status === "active" ? SignageDevices.configHash(await this.applyConfig(d)) : null;
      const reported = d.latest?.settingsHash ?? null;
      const settingsApplied = d.status !== "active" || (expected === d.appliedSettingsHash && (reported === null ? !d.latest : reported === expected));
      const agentOutOfDate = !!current && !!d.agentVersion && compareVersions(d.agentVersion, current) < 0;
      const problems = deviceProblems(
        {
          status: d.status as SignageDeviceStatus,
          enabled: d.enabled,
          lastSeenAt: d.lastSeenAt,
          lastError: d.lastError,
          hostKeyMismatch: d.hostKeyMismatch,
          settingsApplied,
          keyOutOfDate: d.status === "active" && d.keyGeneration !== gen,
          manifestApplied: d.manifestVersionApplied,
          manifestWanted: s?.version ?? null,
          manifestWantedSince: d.manifestWantedSince,
          shouldBeOn: power === null ? null : power === "on",
          hasScreen: !!d.screenId,
          latest: d.latest,
          agentOutOfDate,
          currentAgent: current,
        },
        now,
      );
      out.push({
        id: d.id,
        name: d.name,
        screenId: d.screenId,
        screenName: s?.name ?? null,
        ip: d.ip,
        sshPort: d.sshPort,
        hostKey: d.knownHostKey,
        loginUser: d.loginUser,
        keyGeneration: d.keyGeneration,
        serial: d.serial,
        model: d.model,
        osRelease: d.osRelease,
        macWlan: d.macWlan,
        macEth: d.macEth,
        agentVersion: d.agentVersion,
        status: d.status as SignageDeviceStatus,
        enabled: d.enabled,
        online: !!d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() < SIGNAGE_ONLINE_MS,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        lastError: d.lastError,
        manifestVersionApplied: d.manifestVersionApplied,
        manifestVersionWanted: s?.version ?? null,
        settingsApplied,
        latest: d.latest,
        problems,
        identifyCode: d.identifyUntil && d.identifyUntil > now ? d.identifyCode : null,
        identifyUntil: d.identifyUntil && d.identifyUntil > now ? d.identifyUntil.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      });
    }
    return out;
  }

  async samples(id: string, hours: number) {
    await this.row(id);
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.db.select().from(signageStatusSamples).where(and(eq(signageStatusSamples.deviceId, id), gte(signageStatusSamples.ts, since))).orderBy(signageStatusSamples.ts);
    return rows.map((r) => ({ ts: r.ts.toISOString(), cpuTempC: r.cpuTempC, wifiRssiDbm: r.wifiRssiDbm, diskFreeMb: r.diskFreeMb, memFreeMb: r.memFreeMb }));
  }

  // ------------------------------------------------------------ changing

  async update(id: string, input: { name?: string; screenId?: string | null; enabled?: boolean }): Promise<SignageDevice> {
    const d = await this.row(id);
    if (input.screenId) {
      await this.content.screenRow(input.screenId);
      const [taken] = await this.db.select({ id: signageDevices.id, name: signageDevices.name }).from(signageDevices).where(eq(signageDevices.screenId, input.screenId));
      if (taken && taken.id !== id) throw new ConflictException(`${taken.name} already drives that screen. Move it first.`);
    }
    await this.db
      .update(signageDevices)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.screenId !== undefined ? { screenId: input.screenId, manifestVersionApplied: null, manifestWantedSince: new Date() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled, ...(input.enabled ? { lastSeenAt: null, offlineAlerted: false } : {}) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(signageDevices.id, id));
    if (input.screenId !== undefined) await this.content.markDirty([input.screenId, d.screenId].filter((x): x is string => !!x));
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const d = await this.row(id);
    await this.db.delete(signageDevices).where(eq(signageDevices.id, id));
    if (d.screenId) await this.content.markDirty([d.screenId]);
  }

  /** Forget the pinned host key: the next login pins whatever the Pi presents (after a re-flash, or a replaced SD card). */
  async trustNewHostKey(id: string): Promise<SignageDevice> {
    await this.row(id);
    await this.db.update(signageDevices).set({ knownHostKey: null, hostKeyMismatch: false, lastError: null, updatedAt: new Date() }).where(eq(signageDevices.id, id));
    return this.get(id);
  }

  /** After a login with no pinned key: record the one seen. */
  async pinIfUnpinned(d: DeviceRow, seen: string | null): Promise<void> {
    if (!d.knownHostKey && seen) await this.db.update(signageDevices).set({ knownHostKey: seen }).where(eq(signageDevices.id, d.id));
  }

  // ------------------------------------------------------------ identify and commands

  async identify(input: SignageIdentifyInput): Promise<SignageIdentifyResult> {
    const rows = input.all
      ? await this.db.select().from(signageDevices).where(and(eq(signageDevices.status, "active"), eq(signageDevices.enabled, true)))
      : await this.db.select().from(signageDevices).where(inArray(signageDevices.id, input.deviceIds ?? []));
    if (!rows.length) throw new BadRequestException("No devices to identify");
    const codes = identifyCodes(rows.length);
    const until = new Date(Date.now() + input.seconds * 1000);
    const results = await mapLimit(rows, 8, async (d, i) => {
      const code = codes[i]!;
      const label = Buffer.from(d.name, "utf8").toString("base64url").slice(0, 400);
      try {
        await this.ctl(d, "identify", [code, String(input.seconds), label], { timeoutMs: 15_000 });
        await this.db.update(signageDevices).set({ identifyCode: code, identifyUntil: until }).where(eq(signageDevices.id, d.id));
        return { deviceId: d.id, name: d.name, ip: d.ip, code, error: null };
      } catch (err) {
        return { deviceId: d.id, name: d.name, ip: d.ip, code: null, error: (err as Error).message };
      }
    });
    return { until: until.toISOString(), devices: results };
  }

  async hideCodes(): Promise<{ hidden: number }> {
    const rows = await this.db.select().from(signageDevices).where(and(isNotNull(signageDevices.identifyUntil), gte(signageDevices.identifyUntil, new Date())));
    await mapLimit(rows, 8, async (d) => {
      await this.ctl(d, "identify", ["off"], { timeoutMs: 10_000 }).catch(() => undefined);
      await this.db.update(signageDevices).set({ identifyCode: null, identifyUntil: null }).where(eq(signageDevices.id, d.id));
    });
    return { hidden: rows.length };
  }

  async command(id: string, c: SignageCommandInput): Promise<SignageCommandResult> {
    const d = await this.row(id);
    if (!d.enabled) throw new ConflictException("This device is switched off in the dashboard.");
    const run = async (cmd: string, args: string[] = [], timeoutMs = 30_000) => this.ctl(d, cmd, args, { timeoutMs });
    try {
      switch (c.type) {
        case "restart_player":
          await run("restart-player");
          return { ok: true, message: "The player is restarting.", via: "pi" };
        case "restart_agent":
          await run("restart-agent");
          return { ok: true, message: "The agent is restarting.", via: "pi" };
        case "reboot":
          await run("reboot");
          return { ok: true, message: "The Pi is rebooting (about a minute).", via: "pi" };
        case "tv_state":
          return { ok: true, message: "The TV answered.", via: "pi", output: (await run("tv", ["state"])).tv };
        case "tv_power":
          await run("tv", ["power", c.state]);
          return { ok: true, message: `TV switched ${c.state}.`, via: "pi" };
        case "tv_input":
          await run("tv", ["input", c.input]);
          return { ok: true, message: `TV input set to ${c.input}.`, via: "pi" };
        case "diag":
          return { ok: true, message: "Diagnostics read.", via: "pi", output: await run("diag", [], 60_000) };
        case "os_update": {
          const r = await run("os-update");
          return { ok: r.started === true, message: r.started ? "OS update started. The Pi may reboot." : `Not started: ${String(r.state ?? "an update is already running")}`, via: "pi" };
        }
        default:
          throw new BadRequestException("That command is handled elsewhere");
      }
    } catch (err) {
      if ((c.type === "tv_power" || c.type === "tv_input") && err instanceof PiSshError && (err.kind === "unreachable" || err.kind === "timeout")) {
        const viaRoku = await this.rokuFallback(d, c);
        if (viaRoku) return viaRoku;
      }
      if (err instanceof CtlError || err instanceof PiSshError) return { ok: false, message: err.message, via: "pi" };
      throw err;
    }
  }

  /** The Pi does not answer: a Roku TV can still be switched over ECP from the API (private address, 5 s). */
  private async rokuFallback(d: DeviceRow, c: SignageCommandInput): Promise<SignageCommandResult | null> {
    if (!d.screenId) return null;
    const s = await this.content.screenRow(d.screenId);
    if (s.tvControl !== "roku_ecp" || !s.rokuIp) return null;
    const key = c.type === "tv_power" ? (c.state === "on" ? "PowerOn" : "PowerOff") : c.type === "tv_input" ? c.input : null;
    if (!key) return null;
    return rokuKeypress(s.rokuIp, key);
  }

  async screenTv(screenId: string, action: "on" | "off" | "input" | "state", input?: string): Promise<SignageCommandResult> {
    const devices = await this.content.deviceByScreen();
    const d = devices.get(screenId);
    const s = await this.content.screenRow(screenId);
    const c: SignageCommandInput = action === "state" ? { type: "tv_state" } : action === "input" ? { type: "tv_input", input: input as never } : { type: "tv_power", state: action };
    if (d && d.status === "active") return this.command(d.id, c);
    if (s.tvControl === "roku_ecp" && s.rokuIp && c.type !== "tv_state") {
      return rokuKeypress(s.rokuIp, c.type === "tv_power" ? (c.state === "on" ? "PowerOn" : "PowerOff") : (c as { input: string }).input);
    }
    throw new ConflictException("No Pi is set up for this screen and its TV is not a Roku with an address.");
  }

  async powerAll(state: "on" | "off", groupId: string | null): Promise<{ results: Array<{ screenId: string; name: string; ok: boolean; message: string }> }> {
    const screens = await this.content.screenRows();
    const groups = await this.content.groupIdsByScreen();
    const wanted = screens.filter((s) => s.enabled && s.tvControl !== "none" && (!groupId || (groups.get(s.id) ?? []).includes(groupId)));
    const results = await mapLimit(wanted, 8, async (s) => {
      try {
        const r = await this.screenTv(s.id, state);
        return { screenId: s.id, name: s.name, ok: r.ok, message: r.message };
      } catch (err) {
        return { screenId: s.id, name: s.name, ok: false, message: (err as Error).message };
      }
    });
    return { results };
  }

  async screenshot(id: string): Promise<{ takenAt: string }> {
    const d = await this.row(id);
    const r = await this.ctl(d, "screenshot", [], { timeoutMs: 30_000 });
    const b64 = typeof r.jpegB64 === "string" ? r.jpegB64 : "";
    if (!b64 || b64.length > 6 * 1024 * 1024) throw new CtlError("The Pi returned no picture.");
    const now = new Date();
    await this.db.insert(signageScreenshots).values({ deviceId: id, jpegB64: b64, takenAt: now }).onConflictDoUpdate({ target: signageScreenshots.deviceId, set: { jpegB64: b64, takenAt: now } });
    return { takenAt: now.toISOString() };
  }

  async lastScreenshot(id: string): Promise<{ jpeg: Buffer; takenAt: Date } | null> {
    const [r] = await this.db.select().from(signageScreenshots).where(eq(signageScreenshots.deviceId, id));
    return r ? { jpeg: Buffer.from(r.jpegB64, "base64"), takenAt: r.takenAt } : null;
  }

  async logs(id: string, lines: number): Promise<{ lines: string[] }> {
    const r = await this.ctl(await this.row(id), "logs", [String(Math.max(1, Math.min(2000, lines)))], { timeoutMs: 30_000 });
    return { lines: Array.isArray(r.lines) ? (r.lines as unknown[]).map(String) : [] };
  }

  /** The newest setup runs (all, or one device's). */
  async runsFor(deviceId: string | null, limit = 20) {
    return this.db
      .select()
      .from(signageSetupRuns)
      .where(deviceId ? eq(signageSetupRuns.deviceId, deviceId) : undefined)
      .orderBy(desc(signageSetupRuns.createdAt))
      .limit(limit);
  }

  /** What a poll learned. Fields the agent did not send are left as they were. */
  async recordStatus(d: DeviceRow, raw: unknown): Promise<SignagePiStatus | null> {
    const parsed = signagePiStatusSchema.safeParse(raw);
    if (!parsed.success) {
      await this.db.update(signageDevices).set({ lastSeenAt: new Date(), lastError: "The Pi's status could not be read (agent too old or too new?)" }).where(eq(signageDevices.id, d.id));
      return null;
    }
    const s = parsed.data;
    const now = new Date();
    await this.db
      .update(signageDevices)
      .set({
        latest: s,
        lastSeenAt: now,
        lastError: s.lastError ?? null,
        agentVersion: s.agentVersion ?? d.agentVersion,
        model: s.model || d.model,
        serial: s.serial || d.serial,
        osRelease: s.osVersion || d.osRelease,
        manifestVersionApplied: s.manifestVersion ?? d.manifestVersionApplied,
        offlineAlerted: d.offlineAlerted,
        updatedAt: now,
      })
      .where(eq(signageDevices.id, d.id));
    await this.db.insert(signageStatusSamples).values({ deviceId: d.id, ts: now, cpuTempC: s.cpuTempC ?? null, wifiRssiDbm: s.wifiRssiDbm ?? null, diskFreeMb: s.diskFreeMb ?? null, memFreeMb: s.memFreeMb ?? null });
    return s;
  }
}

/** One ECP keypress to a Roku on a private address (the API's own fallback when the Pi does not answer). */
export async function rokuKeypress(ip: string, key: string): Promise<SignageCommandResult> {
  if (!isPrivateUnicast(ip)) return { ok: false, message: `${ip} is not a private address.`, via: "roku" };
  if (!/^[A-Za-z0-9]{1,30}$/.test(key)) return { ok: false, message: "Not a Roku key.", via: "roku" };
  try {
    const r = await fetch(`http://${ip}:8060/keypress/${key}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return r.ok ? { ok: true, message: `Sent ${key} to the Roku directly (the Pi did not answer).`, via: "roku" } : { ok: false, message: `The Roku answered ${r.status}.`, via: "roku" };
  } catch (err) {
    return { ok: false, message: `Neither the Pi nor the Roku at ${ip} answered (${(err as Error).message}).`, via: "roku" };
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

