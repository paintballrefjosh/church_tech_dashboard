import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PERMISSIONS,
  SIGNAGE_KEYS,
  addSignageIpsSchema,
  signageCommandSchema,
  signageDiscoverySubnetSchema,
  signageIdentifySchema,
  signagePowerAllSchema,
  signageReleaseSchema,
  signageScreenTvSchema,
  signageSetupSchema,
  signageClearCodeSchema,
  signageShowCodeSchema,
  updateSignageDeviceSchema,
  updateSignageDiscoverySubnetSchema,
} from "@lampstand/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { OperationalOnly } from "../auth/operational-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { SettingsService } from "../settings/settings.service";
import { parse } from "./signage.controller";
import { SignageDevices } from "./devices.service";
import { SignageDiscovery } from "./discovery.service";
import { SignageSetup } from "./setup.service";
import { SignageSync } from "./sync.service";
import { SignageReleases } from "./releases.service";

const ADMIN = PERMISSIONS.SIGNAGE_ADMIN;
const idParam = (p: Record<string, string>) => p.id ?? null;
const SECRET_KEYS = ["password", "sudoPassword"];

/**
 * Signage devices, discovery, setup runs, the dashboard's key and agent releases (docs/signage.md sections 2-7, 9).
 * All of it is the module's admin tier. Routes that reach a Pi or a TV are `@OperationalOnly`: an API token needs the
 * operational level for them. Passwords typed for a Pi are never stored past the run and never in the audit log.
 */
@Controller("signage")
@RequirePermissions(ADMIN)
export class SignageDevicesController {
  constructor(
    private readonly devices: SignageDevices,
    private readonly discovery: SignageDiscovery,
    private readonly setup: SignageSetup,
    private readonly sync: SignageSync,
    private readonly releases: SignageReleases,
    private readonly settings: SettingsService,
  ) {}

  // ------------------------------------------------------------ devices

  @Get("devices")
  list() {
    return this.devices.list();
  }

  @Get("devices/:id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.devices.get(id);
  }

  @Patch("devices/:id")
  @Audited({ action: "signage.device.update", resourceType: "signage_device", resourceIdFromParams: idParam })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.devices.update(id, parse(updateSignageDeviceSchema, body));
  }

  /**
   * Forget a device. By default the Pi is reset to a normal Raspberry Pi first (`?reset=0` forgets it and leaves it as it is:
   * it then stays locked to the dashboard's key, and Set up again finds it by that key). With a reset the device stays,
   * `resetting`, until a `forget` run (`runId`) sees the reset finish; only then is it gone.
   */
  @Delete("devices/:id")
  @OperationalOnly()
  @Audited({ action: "signage.device.delete", resourceType: "signage_device", resourceIdFromParams: idParam })
  async remove(@Param("id", ParseUUIDPipe) id: string, @Query("reset") reset?: string) {
    const r = await this.setup.forget(id, reset !== "0" && reset !== "false");
    return { ok: true, reset: r.reset, ...(r.runId ? { runId: r.runId } : {}) };
  }

  @Post("devices/:id/trust-host-key")
  @Audited({ action: "signage.device.trust_host_key", resourceType: "signage_device", resourceIdFromParams: idParam })
  trust(@Param("id", ParseUUIDPipe) id: string) {
    return this.devices.trustNewHostKey(id);
  }

  @Post("devices/:id/command")
  @OperationalOnly()
  @Audited({ action: "signage.device.command", resourceType: "signage_device", resourceIdFromParams: idParam })
  async command(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const c = parse(signageCommandSchema, body);
    if (c.type === "sync_now") {
      const r = await this.sync.syncNow(id);
      return { ok: true, message: `Copied ${r.copied} file${r.copied === 1 ? "" : "s"}; manifest ${r.manifestVersion ?? "not"} sent${r.missing ? `; ${r.missing} still missing` : ""}.`, via: "pi", output: r };
    }
    if (c.type === "agent_update") {
      const run = await this.setup.queue(id, "agent_update", user.id);
      return { ok: true, message: "Agent update queued.", via: "pi", output: { runId: run.id } };
    }
    return this.devices.command(id, c);
  }

  @Post("devices/:id/apply")
  @OperationalOnly()
  @Audited({ action: "signage.device.apply", resourceType: "signage_device", resourceIdFromParams: idParam })
  apply(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.setup.queue(id, "apply", user.id);
  }

  @Post("devices/:id/screenshot")
  @OperationalOnly()
  @Audited({ action: "signage.device.screenshot", resourceType: "signage_device", resourceIdFromParams: idParam })
  screenshot(@Param("id", ParseUUIDPipe) id: string) {
    return this.devices.screenshot(id);
  }

  @Get("devices/:id/screenshot")
  async lastScreenshot(@Param("id", ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const shot = await this.devices.lastScreenshot(id);
    if (!shot) throw new NotFoundException("No picture yet");
    return reply.header("content-type", "image/jpeg").header("cache-control", "private, no-cache").header("x-content-type-options", "nosniff").header("last-modified", shot.takenAt.toUTCString()).send(shot.jpeg);
  }

  @Get("devices/:id/logs")
  @OperationalOnly()
  logs(@Param("id", ParseUUIDPipe) id: string, @Query("lines") lines?: string) {
    return this.devices.logs(id, Number(lines) || 200);
  }

  /** What the TV says now (power and, where it says, the input): asked of the Pi live. A read, so not audited, like the logs. */
  @Get("devices/:id/tv")
  @OperationalOnly()
  tvOfDevice(@Param("id", ParseUUIDPipe) id: string) {
    return this.devices.tvNow(id);
  }

  @Get("devices/:id/samples")
  samples(@Param("id", ParseUUIDPipe) id: string, @Query("hours") hours?: string) {
    return this.devices.samples(id, Math.max(1, Math.min(24 * 7, Number(hours) || 24)));
  }

  @Get("devices/:id/runs")
  deviceRuns(@Param("id", ParseUUIDPipe) id: string) {
    return this.setup.list(id);
  }

  // ------------------------------------------------------------ identify

  @Post("identify")
  @OperationalOnly()
  @Audited({ action: "signage.identify", resourceType: "signage_device" })
  identify(@Body() body: unknown) {
    return this.devices.identify(parse(signageIdentifySchema, body));
  }

  @Post("identify/off")
  @OperationalOnly()
  @Audited({ action: "signage.identify_off", resourceType: "signage_device" })
  identifyOff() {
    return this.devices.hideCodes();
  }

  // ------------------------------------------------------------ setup runs

  @Post("setup")
  @OperationalOnly()
  @HttpCode(202)
  @Audited({ action: "signage.device.setup", resourceType: "signage_device", redactKeys: SECRET_KEYS })
  startSetup(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.setup.setup(parse(signageSetupSchema, body), user.id);
  }

  @Get("runs")
  runs(@Query("deviceId") deviceId?: string) {
    if (deviceId && !z.string().uuid().safeParse(deviceId).success) throw new BadRequestException("Not a device id");
    return this.setup.list(deviceId ?? null);
  }

  @Get("runs/:id")
  run(@Param("id", ParseUUIDPipe) id: string) {
    return this.setup.get(id);
  }

  @Post("runs/:id/sudo")
  @OperationalOnly()
  @SessionOnly()
  @Audited({ action: "signage.run.sudo", resourceType: "signage_run", resourceIdFromParams: idParam, redactKeys: SECRET_KEYS })
  sudo(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.setup.giveSudo(id, parse(z.object({ sudoPassword: z.string().min(1).max(200) }).strict(), body).sudoPassword);
  }

  // ------------------------------------------------------------ discovery

  @Get("discovery/subnets")
  subnets() {
    return this.discovery.subnets();
  }

  @Post("discovery/subnets")
  @Audited({ action: "signage.discovery.subnet.create", resourceType: "signage_subnet" })
  addSubnet(@Body() body: unknown) {
    return this.discovery.addSubnet(parse(signageDiscoverySubnetSchema, body));
  }

  @Patch("discovery/subnets/:id")
  @Audited({ action: "signage.discovery.subnet.update", resourceType: "signage_subnet", resourceIdFromParams: idParam })
  updateSubnet(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.discovery.updateSubnet(id, parse(updateSignageDiscoverySubnetSchema, body));
  }

  @Delete("discovery/subnets/:id")
  @Audited({ action: "signage.discovery.subnet.delete", resourceType: "signage_subnet", resourceIdFromParams: idParam })
  async deleteSubnet(@Param("id", ParseUUIDPipe) id: string) {
    await this.discovery.deleteSubnet(id);
    return { ok: true };
  }

  @Post("discovery/subnets/:id/scan")
  @OperationalOnly()
  @Audited({ action: "signage.discovery.scan", resourceType: "signage_subnet", resourceIdFromParams: idParam })
  scanSubnet(@Param("id", ParseUUIDPipe) id: string) {
    return this.discovery.scanSubnet(id);
  }

  /** Scan a subnet once without listing it. */
  @Post("discovery/scan")
  @OperationalOnly()
  @Audited({ action: "signage.discovery.scan", resourceType: "signage_subnet" })
  scan(@Body() body: unknown) {
    return this.discovery.scanCidr(parse(signageDiscoverySubnetSchema.pick({ cidr: true }), body).cidr);
  }

  @Post("discovery/ips")
  @OperationalOnly()
  @Audited({ action: "signage.discovery.add_ips", resourceType: "signage_found" })
  addIps(@Body() body: unknown) {
    return this.discovery.addIps(parse(addSignageIpsSchema, body).ips);
  }

  @Get("discovery/found")
  found() {
    return this.discovery.found();
  }

  @Post("discovery/found/:id/dismiss")
  @Audited({ action: "signage.discovery.dismiss", resourceType: "signage_found", resourceIdFromParams: idParam })
  async dismiss(@Param("id", ParseUUIDPipe) id: string) {
    await this.discovery.dismiss(id, true);
    return { ok: true };
  }

  @Post("discovery/found/:id/undismiss")
  @Audited({ action: "signage.discovery.undismiss", resourceType: "signage_found", resourceIdFromParams: idParam })
  async undismiss(@Param("id", ParseUUIDPipe) id: string) {
    await this.discovery.dismiss(id, false);
    return { ok: true };
  }

  @Post("discovery/found/:id/show-code")
  @OperationalOnly()
  @Audited({ action: "signage.discovery.show_code", resourceType: "signage_found", resourceIdFromParams: idParam, redactKeys: SECRET_KEYS })
  showCode(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.discovery.showCode(id, parse(signageShowCodeSchema, body));
  }

  /** The window that showed a code was closed: take the code off the TV (the player's overlay, or the text console). */
  @Post("discovery/found/:id/clear-code")
  @OperationalOnly()
  @Audited({ action: "signage.discovery.clear_code", resourceType: "signage_found", resourceIdFromParams: idParam, redactKeys: SECRET_KEYS })
  clearCode(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.discovery.clearCode(id, parse(signageClearCodeSchema, body));
  }

  // ------------------------------------------------------------ the dashboard's key

  @Get("key")
  key() {
    return this.devices.keyInfo();
  }

  /** Move to the next key: every Pi is moved on its next "Apply again" (queued here for the reachable ones). */
  @Post("key/rotate")
  @OperationalOnly()
  @Audited({ action: "signage.key.rotate", resourceType: "signage_key" })
  async rotate(@CurrentUser() user: AuthenticatedUser) {
    const next = (await this.devices.keyGeneration()) + 1;
    await this.settings.set(SIGNAGE_KEYS.keyGeneration, next, user.id);
    const list = await this.devices.list();
    let queued = 0;
    // A Pi that cannot be queued now (a run already waiting) keeps the old key until "Apply again": say which.
    const notQueued: Array<{ deviceId: string; name: string; error: string }> = [];
    for (const d of list.filter((x) => x.status === "active" && x.enabled)) {
      await this.setup
        .queue(d.id, "apply", user.id, { rotate: true })
        .then(() => queued++)
        .catch((err: Error) => notQueued.push({ deviceId: d.id, name: d.name, error: err.message }));
    }
    return { ...(await this.devices.keyInfo()), queued, notQueued };
  }

  // ------------------------------------------------------------ agent releases

  @Get("releases")
  listReleases() {
    return this.releases.list();
  }

  @Post("releases")
  @SessionOnly()
  @Audited({ action: "signage.release.upload", resourceType: "signage_release" })
  async uploadRelease(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest, @Query("notes") notes?: string) {
    const part = await (req as FastifyRequest & {
      file: (opts?: { limits?: { fileSize?: number } }) => Promise<{ file: NodeJS.ReadableStream & { truncated?: boolean } } | undefined>;
    }).file({ limits: { fileSize: 32 * 1024 * 1024 } });
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    try {
      return await this.releases.upload(part.file as never, () => part.file.truncated === true, parse(signageReleaseSchema, { notes: notes ?? "" }).notes, user.id);
    } finally {
      part.file.resume?.();
    }
  }

  @Post("releases/:id/current")
  @Audited({ action: "signage.release.current", resourceType: "signage_release", resourceIdFromParams: idParam })
  setCurrent(@Param("id") id: string) {
    if (id !== "bundled" && !z.string().uuid().safeParse(id).success) throw new BadRequestException("Not a release id");
    return this.releases.setCurrent(id);
  }

  /** Queue an agent update on every set-up Pi that runs another version. */
  @Post("releases/rollout")
  @OperationalOnly()
  @Audited({ action: "signage.release.rollout", resourceType: "signage_release" })
  async rollout(@CurrentUser() user: AuthenticatedUser) {
    const cur = await this.releases.current();
    if (!cur) throw new BadRequestException("No release to roll out");
    const list = await this.devices.list();
    let queued = 0;
    for (const d of list.filter((x) => x.status === "active" && x.enabled && x.agentVersion !== cur.version)) {
      await this.setup
        .queue(d.id, "agent_update", user.id)
        .then(() => queued++)
        .catch(() => undefined);
    }
    return { version: cur.version, queued };
  }

  // ------------------------------------------------------------ TVs

  @Post("screens/:id/tv")
  @OperationalOnly()
  @Audited({ action: "signage.screen.tv", resourceType: "signage_screen", resourceIdFromParams: idParam })
  tv(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const t = parse(signageScreenTvSchema, body);
    return this.devices.screenTv(id, t.action, t.input);
  }

  /** Every controlled TV (or one screen group's) on or off now. */
  @Post("power-all")
  @OperationalOnly()
  @Audited({ action: "signage.power_all", resourceType: "signage_screen" })
  powerAll(@Body() body: unknown) {
    const p = parse(signagePowerAllSchema, body);
    return this.devices.powerAll(p.state, p.groupId);
  }
}

/** Counts for the Signage pages' badges and the home page: any reader of the module (no device details). */
@Controller("signage")
export class SignageSummaryController {
  constructor(
    private readonly devices: SignageDevices,
    private readonly discovery: SignageDiscovery,
  ) {}

  @Get("summary")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  async summary() {
    const list = await this.devices.list();
    return {
      devices: list.length,
      online: list.filter((d) => d.online).length,
      attention: list.filter((d) => d.problems.some((p) => p.severity !== "info")).length,
      newFound: await this.discovery.newCount(),
      /** The site's time zone: schedule times are on this clock (the Schedule page draws its calendar in it). */
      timezone: await this.devices.zone(),
    };
  }
}
