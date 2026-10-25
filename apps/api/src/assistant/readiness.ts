import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  ASSISTANT_KEYS,
  ASSISTANT_STATE,
  assistantDestination,
  assistantReadiness,
  type AssistantLastTest,
  type AssistantPrivacyAck,
  type AssistantReadinessFacts,
} from "@church/shared";
import type { Db } from "../db/db.module";
import { groupModuleAccess, jobState } from "../db/schema";

export interface AssistantConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  verifyTls: boolean;
  maxOutputTokens: number;
  maxSteps: number;
  timeoutSec: number;
  priceIn: number;
  priceOut: number;
  monthlyBudget: number;
  ratePerMin: number;
  daily: number;
  maxConcurrent: number;
  retentionDays: number;
}

type Getter = (key: string) => Promise<unknown>;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The assistant's settings, with the catalogue's defaults for anything unset. */
export async function readAssistantConfig(get: Getter): Promise<AssistantConfig> {
  const k = ASSISTANT_KEYS;
  const [enabled, provider, baseUrl, apiKey, model, verifyTls, maxOut, steps, timeout, pin, pout, budget, rate, daily, conc, ret] = await Promise.all(
    [k.enabled, k.provider, k.baseUrl, k.apiKey, k.model, k.verifyTls, k.maxOutputTokens, k.maxSteps, k.timeoutSec, k.priceIn, k.priceOut, k.monthlyBudget, k.userRatePerMin, k.userDaily, k.maxConcurrent, k.retentionDays].map((key) =>
      get(key).catch(() => undefined),
    ),
  );
  return {
    enabled: enabled === true,
    provider: str(provider),
    baseUrl: str(baseUrl),
    apiKey: str(apiKey),
    model: str(model),
    verifyTls: verifyTls !== false,
    maxOutputTokens: num(maxOut, 1500),
    maxSteps: num(steps, 6),
    timeoutSec: num(timeout, 120),
    priceIn: num(pin, 0),
    priceOut: num(pout, 0),
    monthlyBudget: num(budget, 0),
    ratePerMin: num(rate, 6),
    daily: num(daily, 100),
    maxConcurrent: num(conc, 2),
    retentionDays: num(ret, 30),
  };
}

/** What a connection test is valid for: provider, address, model and (a hash of) the key. Editing any of them invalidates it. */
export function assistantFingerprint(c: Pick<AssistantConfig, "provider" | "baseUrl" | "model" | "apiKey">): string {
  const key = createHash("sha256").update(c.apiKey).digest("hex");
  return createHash("sha256").update([c.provider, c.baseUrl, c.model, key].join("\u0000")).digest("hex").slice(0, 32);
}

async function state<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db
    .select({ value: jobState.value })
    .from(jobState)
    .where(and(eq(jobState.job, ASSISTANT_STATE.job), eq(jobState.key, key)))
    .limit(1);
  return (row?.value as T | undefined) ?? null;
}

/** Everything the readiness checklist judges, from the database. The admin group always has every module. */
export async function gatherAssistantReadiness(db: Db, get: Getter) {
  const c = await readAssistantConfig(get);
  const [lastTest, privacy, grants] = await Promise.all([
    state<AssistantLastTest>(db, ASSISTANT_STATE.lastTest),
    state<AssistantPrivacyAck>(db, ASSISTANT_STATE.privacy),
    db.select({ g: groupModuleAccess.groupId }).from(groupModuleAccess).where(eq(groupModuleAccess.moduleKey, "assistant")),
  ]);
  const destination = assistantDestination(c.provider, c.baseUrl);
  const facts: AssistantReadinessFacts = {
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    keySet: c.apiKey !== "",
    fingerprint: assistantFingerprint(c),
    lastTest,
    priceIn: c.priceIn,
    priceOut: c.priceOut,
    monthlyBudget: c.monthlyBudget,
    privacy,
    destination,
    groupsWithModule: grants.length + 1,
  };
  return { config: c, facts, lastTest, privacy, destination, ...assistantReadiness(facts) };
}
