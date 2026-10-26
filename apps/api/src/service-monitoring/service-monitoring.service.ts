import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  BUILTIN_TEMPLATES,
  BUILTIN_TEMPLATE_VERSION,
  SAVED_SECRET,
  evaluateService,
  serviceExprInputs,
  serviceInputProblems,
  serviceTemplateBodySchema,
  serviceTemplateProblems,
  suggestTemplates,
  templateCommands,
  templateRunsCommands,
  type CollectorOutcome,
  type PlaceholderValue,
  type ServiceInputValue,
  type ServiceInstance,
  type ServiceInstanceCreate,
  type ServiceInstanceStatus,
  type ServiceInstanceUpdate,
  type ServiceLogin,
  type ServiceLoginSave,
  type ServiceMember,
  type ServiceCheckResult,
  type ServiceSeriesPoint,
  type ServiceTemplate,
  type ServiceTemplateBody,
  type ServiceTest,
  type ServiceTestResult,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import {
  infraTargets,
  monitorIncidents,
  serviceInstances,
  serviceLogins,
  serviceMetricRollups,
  serviceMetricSamples,
  serviceTemplates,
} from "../db/schema";
import { decryptStoredSecret, encryptSecret } from "../settings/crypto";
import { InfraService } from "../infra/infra.service";
import type { CollectContext } from "../infra/collectors/types";
import { runCollector, type InstanceRunContext } from "./transports";

export type InstanceRow = typeof serviceInstances.$inferSelect;
type TargetRow = typeof infraTargets.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The incident rule id of one check of one instance (`monitor_incidents.rule_id`, on the host's own target id). */
export const serviceRuleId = (instanceId: string, checkId: string) => `svc:${instanceId}:${checkId}`;

/**
 * Service monitoring (docs/service-monitoring.md): templates (built-ins from code, custom ones in the database), shared
 * logins, and the instances attached to infra hosts. The polling is `ServicePoller`. Secrets (secret inputs, login
 * passwords) are encrypted at rest and never returned.
 */
@Injectable()
export class ServiceMonitoringService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly infra: InfraService,
  ) {}

  // ---- templates ----

  async templates(): Promise<ServiceTemplate[]> {
    const custom = await this.db.select().from(serviceTemplates).orderBy(asc(serviceTemplates.key));
    const counts = new Map<string, number>();
    for (const r of await this.db
      .select({ key: serviceInstances.templateKey, n: sql<number>`count(*)::int` })
      .from(serviceInstances)
      .groupBy(serviceInstances.templateKey)) {
      counts.set(r.key, Number(r.n));
    }
    const builtins: ServiceTemplate[] = Object.entries(BUILTIN_TEMPLATES).map(([key, body]) => ({
      key,
      source: "builtin",
      forkedFrom: null,
      version: BUILTIN_TEMPLATE_VERSION,
      runsCommands: templateRunsCommands(body),
      body,
      updatedAt: null,
      instances: counts.get(key) ?? 0,
    }));
    return [
      ...builtins,
      ...custom.map((r) => ({
        key: r.key,
        source: "custom" as const,
        forkedFrom: r.forkedFrom,
        version: r.version,
        runsCommands: r.runsCommands,
        body: r.body as ServiceTemplateBody,
        updatedAt: r.updatedAt.toISOString(),
        instances: counts.get(r.key) ?? 0,
      })),
    ];
  }

  async template(key: string): Promise<ServiceTemplate> {
    const t = (await this.templates()).find((x) => x.key === key);
    if (!t) throw new NotFoundException("No such service template");
    return t;
  }

  /** A template's body by key, or null when it is gone (a custom template deleted under an instance). */
  async templateBody(key: string): Promise<ServiceTemplateBody | null> {
    const builtin = BUILTIN_TEMPLATES[key];
    if (builtin) return builtin;
    const [row] = await this.db.select({ body: serviceTemplates.body }).from(serviceTemplates).where(eq(serviceTemplates.key, key)).limit(1);
    return row ? (row.body as ServiceTemplateBody) : null;
  }

  /**
   * Create or replace a custom template. A template that runs commands on hosts (an ssh collector) is saved only when the
   * caller confirms exactly the commands it will run (`templateCommands`): the confirmation goes into the audit row, and
   * a change to the commands needs a new one.
   */
  async saveTemplate(key: string, raw: unknown, confirm: string[] | undefined, userId: string, forkedFrom?: string): Promise<ServiceTemplate> {
    if (BUILTIN_TEMPLATES[key]) throw new ConflictException(`"${key}" is a built-in template: fork it under another name`);
    const problems = serviceTemplateProblems(raw);
    if (problems.length) throw new BadRequestException({ message: "The template has problems", problems });
    const body = serviceTemplateBodySchema.parse(raw);
    const runsCommands = templateRunsCommands(body);
    if (runsCommands) assertConfirmed(templateCommands(body), confirm);
    const [existing] = await this.db.select().from(serviceTemplates).where(eq(serviceTemplates.key, key)).limit(1);
    const now = new Date();
    if (existing) {
      await this.db
        .update(serviceTemplates)
        .set({ body, runsCommands, version: existing.version + 1, updatedBy: userId, updatedAt: now })
        .where(eq(serviceTemplates.key, key));
    } else {
      await this.db.insert(serviceTemplates).values({ key, body, runsCommands, forkedFrom: forkedFrom ?? null, createdBy: userId, updatedBy: userId });
    }
    return this.template(key);
  }

  async forkTemplate(from: string, key: string, userId: string, confirm: string[] | undefined): Promise<ServiceTemplate> {
    const source = await this.template(from);
    const [existing] = await this.db.select({ key: serviceTemplates.key }).from(serviceTemplates).where(eq(serviceTemplates.key, key)).limit(1);
    if (existing) throw new ConflictException(`A template called "${key}" exists already`);
    return this.saveTemplate(key, { ...source.body, name: `${source.body.name} (copy)` }, confirm, userId, from);
  }

  async deleteTemplate(key: string): Promise<{ key: string }> {
    if (BUILTIN_TEMPLATES[key]) throw new ConflictException("A built-in template cannot be deleted");
    const [used] = await this.db.select({ n: sql<number>`count(*)::int` }).from(serviceInstances).where(eq(serviceInstances.templateKey, key));
    if (Number(used?.n ?? 0) > 0) throw new ConflictException("Services use this template: remove them first");
    const res = await this.db.delete(serviceTemplates).where(eq(serviceTemplates.key, key)).returning({ key: serviceTemplates.key });
    if (!res.length) throw new NotFoundException("No such service template");
    return { key };
  }

  /** Templates whose `detect` units match what is running on the host (the host's discovery). */
  async suggestions(targetId: string, units: Array<{ name: string; active: boolean }>): Promise<Array<{ key: string; unit: string; name: string; attached: boolean }>> {
    const all = await this.templates();
    const attached = new Set(
      (await this.db.select({ k: serviceInstances.templateKey }).from(serviceInstances).where(eq(serviceInstances.targetId, targetId))).map((r) => r.k),
    );
    return suggestTemplates(all, units).map((s) => ({ ...s, name: all.find((t) => t.key === s.key)!.body.name, attached: attached.has(s.key) }));
  }

  // ---- logins ----

  async logins(): Promise<ServiceLogin[]> {
    const rows = await this.db.select().from(serviceLogins).orderBy(asc(serviceLogins.name));
    const uses = await this.loginUses();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      hasPassword: !!r.passwordEnc,
      note: r.note,
      instances: uses.get(r.id) ?? 0,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  private async loginUses(): Promise<Map<string, number>> {
    const uses = new Map<string, number>();
    for (const i of await this.db.select({ inputs: serviceInstances.inputs }).from(serviceInstances)) {
      for (const v of Object.values(i.inputs ?? {})) {
        if (v && typeof v === "object" && "loginId" in v) {
          const id = String((v as { loginId: unknown }).loginId);
          uses.set(id, (uses.get(id) ?? 0) + 1);
        }
      }
    }
    return uses;
  }

  async createLogin(input: ServiceLoginSave): Promise<ServiceLogin> {
    await this.assertLoginNameFree(input.name, null);
    const [row] = await this.db
      .insert(serviceLogins)
      .values({
        name: input.name,
        username: input.username,
        passwordEnc: input.password && input.password !== SAVED_SECRET ? encryptSecret(input.password) : null,
        note: input.note,
      })
      .returning();
    return (await this.logins()).find((l) => l.id === row!.id)!;
  }

  async updateLogin(id: string, input: ServiceLoginSave): Promise<ServiceLogin> {
    const [row] = await this.db.select().from(serviceLogins).where(eq(serviceLogins.id, id)).limit(1);
    if (!row) throw new NotFoundException("No such login");
    await this.assertLoginNameFree(input.name, id);
    const passwordEnc =
      input.password === undefined || input.password === SAVED_SECRET ? row.passwordEnc : input.password === "" ? null : encryptSecret(input.password);
    await this.db
      .update(serviceLogins)
      .set({ name: input.name, username: input.username, passwordEnc, note: input.note, updatedAt: new Date() })
      .where(eq(serviceLogins.id, id));
    return (await this.logins()).find((l) => l.id === id)!;
  }

  async deleteLogin(id: string): Promise<{ id: string }> {
    if ((await this.loginUses()).get(id)) throw new ConflictException("Services use this login: choose another login for them first");
    const res = await this.db.delete(serviceLogins).where(eq(serviceLogins.id, id)).returning({ id: serviceLogins.id });
    if (!res.length) throw new NotFoundException("No such login");
    return { id };
  }

  private async assertLoginNameFree(name: string, exceptId: string | null): Promise<void> {
    const [other] = await this.db.select({ id: serviceLogins.id }).from(serviceLogins).where(eq(serviceLogins.name, name)).limit(1);
    if (other && other.id !== exceptId) throw new ConflictException(`A login called "${name}" exists already`);
  }

  // ---- instances ----

  async list(targetId?: string): Promise<ServiceInstance[]> {
    const rows = await this.db
      .select()
      .from(serviceInstances)
      .where(targetId ? eq(serviceInstances.targetId, targetId) : undefined)
      .orderBy(asc(serviceInstances.name));
    return this.toDto(rows);
  }

  async get(id: string): Promise<ServiceInstance> {
    const [row] = await this.db.select().from(serviceInstances).where(eq(serviceInstances.id, id)).limit(1);
    if (!row) throw new NotFoundException("No such service");
    return (await this.toDto([row]))[0]!;
  }

  async rowById(id: string): Promise<InstanceRow> {
    const [row] = await this.db.select().from(serviceInstances).where(eq(serviceInstances.id, id)).limit(1);
    if (!row) throw new NotFoundException("No such service");
    return row;
  }

  async toDto(rows: InstanceRow[]): Promise<ServiceInstance[]> {
    const targetIds = [...new Set(rows.map((r) => r.targetId))];
    const targets = new Map<string, TargetRow>();
    if (targetIds.length) for (const t of await this.db.select().from(infraTargets).where(inArray(infraTargets.id, targetIds))) targets.set(t.id, t);
    const bodies = new Map<string, ServiceTemplateBody | null>();
    for (const k of new Set(rows.map((r) => r.templateKey))) bodies.set(k, await this.templateBody(k));
    return rows.map((r) => {
      const body = bodies.get(r.templateKey) ?? null;
      const target = targets.get(r.targetId);
      const alertState = (r.alertState ?? {}) as Record<string, { open?: boolean }>;
      const status: ServiceInstanceStatus = !r.enabled || !target?.enabled ? "disabled" : (r.status as ServiceInstanceStatus);
      return {
        id: r.id,
        targetId: r.targetId,
        targetName: target?.name ?? "",
        templateKey: r.templateKey,
        templateName: body?.name ?? `${r.templateKey} (template missing)`,
        name: r.name,
        inputs: (r.inputs ?? {}) as Record<string, ServiceInputValue>,
        secrets: Object.fromEntries(Object.keys(r.secretsEnc ?? {}).map((k) => [k, SAVED_SECRET])),
        intervalSec: r.intervalSec,
        enabled: r.enabled,
        runsCommands: body ? templateRunsCommands(body) : false,
        status,
        lastError: r.lastError,
        lastPolledAt: iso(r.lastPolledAt),
        values: r.lastValues ?? {},
        states: r.lastStates ?? {},
        members: (r.members as ServiceMember[] | null) ?? [],
        membersOmitted: r.membersOmitted,
        checks: ((r.checks as ServiceCheckResult[] | null) ?? []).map((c) => ({ ...c, open: !!alertState[c.id]?.open })),
        collectorErrors: r.collectorErrors ?? {},
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  private async requireTarget(id: string): Promise<TargetRow> {
    const [t] = await this.db.select().from(infraTargets).where(eq(infraTargets.id, id)).limit(1);
    if (!t) throw new NotFoundException("No such host");
    return t;
  }

  private async requireBody(key: string): Promise<ServiceTemplateBody> {
    const body = await this.templateBody(key);
    if (!body) throw new BadRequestException(`No template "${key}"`);
    return body;
  }

  /** The stored secrets after a save: `[saved]` keeps a value, "" removes it, anything else replaces it. */
  private mergeSecrets(body: ServiceTemplateBody, stored: Record<string, string>, given: Record<string, string> | undefined): Record<string, string> {
    const secretKeys = new Set(body.inputs.filter((i) => i.type === "secret").map((i) => i.key));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(stored)) if (secretKeys.has(k)) out[k] = v;
    for (const [k, v] of Object.entries(given ?? {})) {
      if (!secretKeys.has(k)) throw new BadRequestException(`"${k}" is not a secret of this template`);
      if (v === SAVED_SECRET) continue;
      if (v === "") delete out[k];
      else out[k] = encryptSecret(v);
    }
    return out;
  }

  private async assertLogins(values: Record<string, ServiceInputValue>): Promise<void> {
    const ids = Object.values(values)
      .filter((v): v is { loginId: string } => !!v && typeof v === "object" && "loginId" in v)
      .map((v) => v.loginId);
    if (!ids.length) return;
    const found = new Set((await this.db.select({ id: serviceLogins.id }).from(serviceLogins).where(inArray(serviceLogins.id, ids))).map((r) => r.id));
    for (const id of ids) if (!found.has(id)) throw new BadRequestException("A chosen login no longer exists");
  }

  async create(input: ServiceInstanceCreate, userId: string): Promise<ServiceInstance> {
    await this.requireTarget(input.targetId);
    const body = await this.requireBody(input.templateKey);
    if (templateRunsCommands(body)) assertConfirmed(templateCommands(body), input.confirmCommands);
    const secretsEnc = this.mergeSecrets(body, {}, input.secrets);
    const problems = serviceInputProblems(body, input.inputs, new Set(Object.keys(secretsEnc)));
    if (problems.length) throw new BadRequestException({ message: problems.join("; "), problems });
    await this.assertLogins(input.inputs);
    const [row] = await this.db
      .insert(serviceInstances)
      .values({
        targetId: input.targetId,
        templateKey: input.templateKey,
        name: input.name,
        inputs: input.inputs,
        secretsEnc,
        intervalSec: input.intervalSec,
        enabled: input.enabled,
        createdBy: userId,
      })
      .returning();
    return this.get(row!.id);
  }

  async update(id: string, input: ServiceInstanceUpdate): Promise<ServiceInstance> {
    const row = await this.rowById(id);
    const body = await this.requireBody(row.templateKey);
    const inputs = input.inputs ?? ((row.inputs ?? {}) as Record<string, ServiceInputValue>);
    const secretsEnc = input.secrets ? this.mergeSecrets(body, row.secretsEnc ?? {}, input.secrets) : (row.secretsEnc ?? {});
    // Changing what a command template is given, or switching it back on, is running commands again: confirm them.
    if (templateRunsCommands(body) && (input.inputs || (input.enabled === true && !row.enabled))) assertConfirmed(templateCommands(body), input.confirmCommands);
    const problems = serviceInputProblems(body, inputs, new Set(Object.keys(secretsEnc)));
    if (problems.length) throw new BadRequestException({ message: problems.join("; "), problems });
    await this.assertLogins(inputs);
    const turnedOff = input.enabled === false && row.enabled;
    await this.db
      .update(serviceInstances)
      .set({
        name: input.name ?? row.name,
        inputs,
        secretsEnc,
        intervalSec: input.intervalSec ?? row.intervalSec,
        enabled: input.enabled ?? row.enabled,
        updatedAt: new Date(),
        // A changed setup is read afresh at the next tick, and its old counters would give a wrong first rate.
        ...(input.inputs || input.secrets ? { lastPolledAt: null, counters: null } : {}),
        ...(turnedOff ? { status: "unknown", alertState: null } : {}),
      })
      .where(eq(serviceInstances.id, id));
    // Nothing will poll a switched-off service to resolve what it opened.
    if (turnedOff) await this.resolveOpenIncidents(row);
    return this.get(id);
  }

  async remove(id: string): Promise<{ id: string }> {
    const row = await this.rowById(id);
    await this.resolveOpenIncidents(row);
    await this.db.delete(serviceInstances).where(eq(serviceInstances.id, id));
    return { id };
  }

  private async resolveOpenIncidents(row: InstanceRow): Promise<void> {
    await this.db
      .update(monitorIncidents)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(monitorIncidents.targetId, row.targetId),
          isNull(monitorIncidents.resolvedAt),
          sql`${monitorIncidents.ruleId} LIKE ${`svc:${row.id}:%`}`,
        ),
      );
  }

  // ---- readings ----

  /** Raw readings for 24 hours or less, else the 5-minute (up to 14 days) or hourly averages. */
  async series(id: string, from: Date, to: Date): Promise<{ resolution: "raw" | "5m" | "1h"; points: ServiceSeriesPoint[] }> {
    await this.rowById(id);
    const span = to.getTime() - from.getTime();
    if (span <= 24 * 3_600_000) {
      const rows = await this.db
        .select({ ts: serviceMetricSamples.ts, values: serviceMetricSamples.values })
        .from(serviceMetricSamples)
        .where(and(eq(serviceMetricSamples.instanceId, id), gte(serviceMetricSamples.ts, from), lte(serviceMetricSamples.ts, to)))
        .orderBy(asc(serviceMetricSamples.ts))
        .limit(5000);
      return { resolution: "raw", points: rows.map((r) => ({ ts: r.ts.toISOString(), values: r.values ?? {} })) };
    }
    const bucket = span <= 14 * 86_400_000 ? "5m" : "1h";
    const rows = await this.db
      .select({ ts: serviceMetricRollups.ts, metric: serviceMetricRollups.metric, avg: serviceMetricRollups.avg })
      .from(serviceMetricRollups)
      .where(
        and(
          eq(serviceMetricRollups.instanceId, id),
          eq(serviceMetricRollups.bucket, bucket),
          gte(serviceMetricRollups.ts, from),
          lte(serviceMetricRollups.ts, to),
        ),
      )
      .orderBy(asc(serviceMetricRollups.ts))
      .limit(50_000);
    const byTs = new Map<string, Record<string, number | null>>();
    for (const r of rows) {
      const k = r.ts.toISOString();
      const v = byTs.get(k) ?? {};
      v[r.metric] = r.avg === null ? null : Number(r.avg);
      byTs.set(k, v);
    }
    return { resolution: bucket, points: [...byTs.entries()].map(([ts, values]) => ({ ts, values })) };
  }

  async incidents(id: string) {
    const row = await this.rowById(id);
    return this.db
      .select()
      .from(monitorIncidents)
      .where(and(eq(monitorIncidents.targetId, row.targetId), sql`${monitorIncidents.ruleId} LIKE ${`svc:${row.id}:%`}`))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(50);
  }

  // ---- running a template ----

  /**
   * Everything a run needs: placeholder values (inputs with their defaults, `{{host}}`, logins' parts, decrypted
   * secrets), the expression inputs (never a secret) and the host's SSH context.
   */
  async runContext(
    target: TargetRow,
    body: ServiceTemplateBody,
    values: Record<string, ServiceInputValue>,
    secretsEnc: Record<string, string>,
    plainSecrets: Record<string, string> = {},
  ): Promise<{ ctx: InstanceRunContext; exprInputs: ReturnType<typeof serviceExprInputs> }> {
    const vars: Record<string, PlaceholderValue> = { host: { value: target.host, secret: false } };
    const fillHost = (s: string) => s.replace(/\{\{\s*host\s*\}\}/g, target.host);
    for (const i of body.inputs) {
      const v = values[i.key] ?? i.default;
      if (i.type === "secret") {
        const value = plainSecrets[i.key] ?? (secretsEnc[i.key] ? decryptStoredSecret(secretsEnc[i.key]!, `${i.label}`) : "");
        vars[i.key] = { value, secret: true };
      } else if (i.type === "login") {
        const loginId = v && typeof v === "object" && "loginId" in v ? v.loginId : null;
        const [login] = loginId ? await this.db.select().from(serviceLogins).where(eq(serviceLogins.id, loginId)).limit(1) : [];
        vars[`${i.key}.user`] = { value: login?.username ?? "", secret: false };
        vars[`${i.key}.password`] = { value: login?.passwordEnc ? decryptStoredSecret(login.passwordEnc, `the password of the login ${login.name}`) : "", secret: true };
      } else if (v === undefined || typeof v === "object") {
        vars[i.key] = { value: "", secret: false };
      } else {
        vars[i.key] = { value: fillHost(String(v)), secret: false };
      }
    }
    const secrets = Object.values(vars)
      .filter((v) => v.secret && v.value.length >= 4)
      .map((v) => v.value);
    const credential = await this.infra.getCredential(target.id);
    const ssh: CollectContext = {
      targetId: target.id,
      host: target.host,
      options: (target.options as CollectContext["options"]) ?? {},
      credential,
      knownHostKey: target.knownHostKey ?? null,
      prev: null,
    };
    return { ctx: { host: target.host, ssh, vars, secrets }, exprInputs: serviceExprInputs(body, values) };
  }

  /** Runs every collector of a template once (in parallel) and returns their outcomes. */
  async collect(body: ServiceTemplateBody, ctx: InstanceRunContext, keepRaw: boolean) {
    const entries = Object.entries(body.collect);
    const runs = await Promise.all(entries.map(([, c]) => runCollector(c, ctx, { keepRaw })));
    const outcomes: Record<string, CollectorOutcome> = {};
    entries.forEach(([name], i) => (outcomes[name] = { rows: runs[i]!.rows, error: runs[i]!.error }));
    return { entries, runs, outcomes };
  }

  /** The Test button: run a template against a host with the values typed, save nothing, show every step. */
  async test(input: ServiceTest): Promise<ServiceTestResult> {
    const target = await this.requireTarget(input.targetId);
    let body: ServiceTemplateBody;
    if (input.body !== undefined) {
      const problems = serviceTemplateProblems(input.body);
      if (problems.length) return { problems, collectors: [], values: {}, states: {}, members: [], checks: [], down: true };
      body = serviceTemplateBodySchema.parse(input.body);
    } else if (input.templateKey) {
      body = await this.requireBody(input.templateKey);
    } else {
      throw new BadRequestException("Give a template or its text");
    }
    if (templateRunsCommands(body)) assertConfirmed(templateCommands(body), input.confirmCommands);
    let stored: Record<string, string> = {};
    if (input.instanceId) {
      const row = await this.rowById(input.instanceId);
      if (row.targetId !== target.id) throw new BadRequestException("That service is on another host");
      stored = row.secretsEnc ?? {};
    }
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.secrets ?? {})) if (v !== SAVED_SECRET && v !== "") plain[k] = v;
    const keys = new Set([...Object.keys(stored), ...Object.keys(plain)]);
    const problems = serviceInputProblems(body, input.inputs, keys);
    if (problems.length) return { problems, collectors: [], values: {}, states: {}, members: [], checks: [], down: true };
    await this.assertLogins(input.inputs);
    const { ctx, exprInputs } = await this.runContext(target, body, input.inputs, stored, plain);
    const { entries, runs, outcomes } = await this.collect(body, ctx, true);
    const result = evaluateService(body, outcomes, exprInputs, {}, Date.now());
    return {
      problems: [],
      collectors: entries.map(([name, c], i) => ({
        name,
        transport: c.transport,
        ms: runs[i]!.ms,
        error: runs[i]!.error,
        raw: runs[i]!.raw,
        rows: runs[i]!.rows?.length ?? 0,
        sample: (runs[i]!.rows ?? []).slice(0, 20),
      })),
      values: result.values,
      states: result.states,
      members: result.members,
      checks: result.checks,
      down: result.down,
    };
  }
}

/** The person must have been shown, and confirmed, exactly the commands that will run. */
function assertConfirmed(commands: string[], confirm: string[] | undefined): void {
  const same = !!confirm && confirm.length === commands.length && confirm.every((c, i) => c === commands[i]);
  if (!same) {
    throw new ConflictException({
      message: "This template runs commands on the host: confirm them to go on",
      code: "confirm_commands",
      commands,
    });
  }
}
