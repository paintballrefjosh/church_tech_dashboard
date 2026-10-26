import { z } from "zod";
import type { ExprValue } from "./expr";
import type { ServiceMember, ServiceCheckResult } from "./engine";
import type { ServiceTemplateBody } from "./template";

/**
 * Route shapes for service monitoring (apps/api/src/service-monitoring/), and the check of an instance's input values
 * against its template. A secret is never returned: an instance carries `SAVED_SECRET` (`[saved]`) for each secret it holds,
 * and sending it back keeps the stored value ("" removes it), like monitor options.
 */

/** An input value: text, a number, a yes/no, or (a login input) the id of a saved login. */
export const serviceInputValueSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.object({ loginId: z.string().uuid() })]);
export type ServiceInputValue = z.infer<typeof serviceInputValueSchema>;

const inputs = z.record(serviceInputValueSchema).default({});
const secrets = z.record(z.string().max(4000)).default({});

export const SERVICE_INTERVAL = { min: 30, max: 3600 } as const;

export const serviceInstanceCreateSchema = z.object({
  targetId: z.string().uuid(),
  templateKey: z.string().min(1).max(48),
  name: z.string().trim().min(1, "A name is needed").max(120),
  inputs,
  secrets,
  intervalSec: z.number().int().min(SERVICE_INTERVAL.min).max(SERVICE_INTERVAL.max).default(60),
  enabled: z.boolean().default(true),
  /** The commands the person was shown and confirmed, when the template runs commands on the host. */
  confirmCommands: z.array(z.string()).optional(),
});
export type ServiceInstanceCreate = z.infer<typeof serviceInstanceCreateSchema>;

export const serviceInstanceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  inputs: z.record(serviceInputValueSchema).optional(),
  secrets: z.record(z.string().max(4000)).optional(),
  intervalSec: z.number().int().min(SERVICE_INTERVAL.min).max(SERVICE_INTERVAL.max).optional(),
  enabled: z.boolean().optional(),
  confirmCommands: z.array(z.string()).optional(),
});
export type ServiceInstanceUpdate = z.infer<typeof serviceInstanceUpdateSchema>;

/** Run a template once without saving: a saved template (`templateKey`) or one being written (`body`). */
export const serviceTestSchema = z.object({
  targetId: z.string().uuid(),
  templateKey: z.string().min(1).max(48).optional(),
  body: z.unknown().optional(),
  inputs,
  secrets,
  /** Editing an instance: its saved secrets fill the `[saved]` ones. */
  instanceId: z.string().uuid().optional(),
  /** A template that runs commands runs them on this test too: the same confirmation as saving or adding it. */
  confirmCommands: z.array(z.string()).optional(),
});
export type ServiceTest = z.infer<typeof serviceTestSchema>;

export const serviceLoginSaveSchema = z.object({
  name: z.string().trim().min(1, "A name is needed").max(100),
  username: z.string().trim().min(1, "A user name is needed").max(200),
  /** Omitted or `[saved]` keeps the stored password; "" removes it. */
  password: z.string().max(1000).optional(),
  note: z.string().max(500).default(""),
});
export type ServiceLoginSave = z.infer<typeof serviceLoginSaveSchema>;

export interface ServiceLogin {
  id: string;
  name: string;
  username: string;
  hasPassword: boolean;
  note: string;
  instances: number;
  updatedAt: string;
}

export type ServiceInstanceStatus = "unknown" | "up" | "degraded" | "down" | "disabled";

export interface ServiceInstance {
  id: string;
  targetId: string;
  targetName: string;
  templateKey: string;
  templateName: string;
  name: string;
  inputs: Record<string, ServiceInputValue>;
  /** `[saved]` for each secret held. */
  secrets: Record<string, string>;
  intervalSec: number;
  enabled: boolean;
  runsCommands: boolean;
  status: ServiceInstanceStatus;
  lastError: string | null;
  lastPolledAt: string | null;
  values: Record<string, number | null>;
  states: Record<string, string | null>;
  members: ServiceMember[];
  membersOmitted: number;
  checks: Array<ServiceCheckResult & { open: boolean }>;
  collectorErrors: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceTestCollector {
  name: string;
  transport: string;
  ms: number;
  error: string | null;
  raw: string | null;
  rows: number;
  /** The first rows as parsed (at most 20). */
  sample: Array<Record<string, unknown>>;
}

export interface ServiceTestResult {
  problems: string[];
  collectors: ServiceTestCollector[];
  values: Record<string, number | null>;
  states: Record<string, string | null>;
  members: ServiceMember[];
  checks: ServiceCheckResult[];
  down: boolean;
}

export interface ServiceSeriesPoint {
  ts: string;
  values: Record<string, number | null>;
}

/**
 * What is wrong with an instance's values for its template (empty = fine): unknown keys, a required input left empty, a
 * number that is not one, a choice not offered, a login without a saved login. `secretKeys` are the secrets the instance
 * will hold after this save.
 */
export function serviceInputProblems(
  body: Pick<ServiceTemplateBody, "inputs">,
  values: Record<string, ServiceInputValue>,
  secretKeys: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const byKey = new Map(body.inputs.map((i) => [i.key, i]));
  for (const k of Object.keys(values)) {
    const i = byKey.get(k);
    if (!i) problems.push(`"${k}" is not an input of this template`);
    else if (i.type === "secret") problems.push(`${i.label}: a secret goes in secrets, not inputs`);
  }
  for (const i of body.inputs) {
    const v = values[i.key] ?? i.default;
    if (i.type === "secret") {
      if (i.required && !secretKeys.has(i.key)) problems.push(`${i.label} is needed`);
      continue;
    }
    if (i.type === "login") {
      if (v !== undefined && !(typeof v === "object" && v !== null && "loginId" in v)) problems.push(`${i.label}: choose a saved login`);
      else if (i.required && v === undefined) problems.push(`${i.label}: choose a saved login`);
      continue;
    }
    if (v === undefined || v === "") {
      if (i.required) problems.push(`${i.label} is needed`);
      continue;
    }
    if (typeof v === "object") {
      problems.push(`${i.label}: not a login input`);
      continue;
    }
    if (i.type === "number" && (typeof v === "boolean" || !Number.isFinite(Number(v)))) problems.push(`${i.label} must be a number`);
    if (i.type === "bool" && typeof v !== "boolean" && !["true", "false"].includes(String(v))) problems.push(`${i.label} must be yes or no`);
    if (i.type === "select" && !(i.options ?? []).includes(String(v))) problems.push(`${i.label}: "${String(v)}" is not one of the choices`);
    if ((i.type === "string" || i.type === "select") && /[\r\n]/.test(String(v))) problems.push(`${i.label} must be one line`);
    if (typeof v === "string" && /\{\{(?!\s*host\s*\}\})/.test(v)) problems.push(`${i.label}: only {{host}} may be used inside a value`);
  }
  return problems;
}

/**
 * The values an expression may read as `inputs.<key>`: plain inputs only, with their defaults. Secrets and logins are
 * left out, so no metric, state or check text can ever show one.
 */
export function serviceExprInputs(body: Pick<ServiceTemplateBody, "inputs">, values: Record<string, ServiceInputValue>): Record<string, ExprValue> {
  const out: Record<string, ExprValue> = {};
  for (const i of body.inputs) {
    if (i.type === "secret" || i.type === "login") continue;
    const v = values[i.key] ?? i.default ?? "";
    if (typeof v === "object") continue;
    if (i.type === "number") out[i.key] = v === "" ? null : Number(v);
    else if (i.type === "bool") out[i.key] = v === true || v === "true";
    else out[i.key] = String(v);
  }
  return out;
}
