/**
 * The assistant (docs/assistant.md): an in-app chat over what the site knows, answered by an EXTERNAL model the site
 * admin points it at (the Claude API, or any OpenAI-compatible server they run). Off until a site admin has configured
 * it, tested it, set a budget and acknowledged what is sent; read-only; acts as the person asking. The rules here are
 * pure, unit-tested in apps/api/test/assistant.test.ts.
 */

export const ASSISTANT_PROVIDERS = ["anthropic", "openai_compatible"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

export const ASSISTANT_KEYS = {
  enabled: "assistant.enabled",
  provider: "assistant.provider",
  baseUrl: "assistant.base_url",
  apiKey: "assistant.api_key",
  model: "assistant.model",
  verifyTls: "assistant.verify_tls",
  maxOutputTokens: "assistant.max_output_tokens",
  maxSteps: "assistant.max_steps",
  timeoutSec: "assistant.request_timeout_sec",
  priceIn: "assistant.price_in_per_mtok",
  priceOut: "assistant.price_out_per_mtok",
  monthlyBudget: "assistant.monthly_budget",
  userRatePerMin: "assistant.user_rate_per_min",
  userDaily: "assistant.user_daily_questions",
  maxConcurrent: "assistant.max_concurrent",
  retentionDays: "assistant.history_retention_days",
} as const;

/** Where the API keeps what the admin's actions recorded (job_state, not settings: never typed by hand). */
export const ASSISTANT_STATE = { job: "assistant", lastTest: "last-test", privacy: "privacy" } as const;

/** The prompt's version, stored with every answer so a change in quality can be traced to a change in the prompt. */
export const ASSISTANT_PROMPT_VERSION = 1;

export interface AssistantLastTest {
  /** `assistantFingerprint` of the settings the test ran with: editing provider, URL, key or model invalidates it. */
  fingerprint: string;
  at: string;
  ok: boolean;
  model: string;
  latencyMs: number;
  detail: string;
}

export interface AssistantPrivacyAck {
  userId: string;
  name: string;
  at: string;
  /** The provider and host the notice named; a different destination needs a new acknowledgement. */
  destination: string;
}

export interface AssistantReadinessFacts {
  provider: string;
  model: string;
  baseUrl: string;
  keySet: boolean;
  fingerprint: string;
  lastTest: AssistantLastTest | null;
  priceIn: number;
  priceOut: number;
  monthlyBudget: number;
  privacy: AssistantPrivacyAck | null;
  destination: string;
  groupsWithModule: number;
}

export interface ReadinessItem {
  id: "provider" | "test" | "access" | "budget" | "privacy";
  ok: boolean;
  label: string;
  detail: string;
}

/** Where the data goes, in words for the privacy notice: "Anthropic (api.anthropic.com)". */
export function assistantDestination(provider: string, baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl || (provider === "anthropic" ? "https://api.anthropic.com" : "")).host;
  } catch {
    host = baseUrl;
  }
  return `${provider === "anthropic" ? "Anthropic" : "OpenAI-compatible server"} (${host || "no address"})`;
}

/** The checklist that must be all green before `assistant.enabled` can be turned on (the API enforces it). */
export function assistantReadiness(f: AssistantReadinessFacts): { ready: boolean; items: ReadinessItem[] } {
  const providerOk =
    (ASSISTANT_PROVIDERS as readonly string[]).includes(f.provider) &&
    f.model.trim() !== "" &&
    (f.provider === "anthropic" ? f.keySet : f.baseUrl.trim() !== "");
  const testOk = !!f.lastTest?.ok && f.lastTest.fingerprint === f.fingerprint;
  const free = f.priceIn === 0 && f.priceOut === 0;
  const items: ReadinessItem[] = [
    {
      id: "provider",
      ok: providerOk,
      label: "A provider and model are chosen",
      detail: f.provider === "anthropic" ? "The Claude API needs an API key and a model id." : "An OpenAI-compatible server needs its address and a model name.",
    },
    {
      id: "test",
      ok: testOk,
      label: "Test connection passed with these settings",
      detail: f.lastTest && !testOk && f.lastTest.fingerprint !== f.fingerprint ? "The settings changed since the last test: run it again." : "Run Test connection.",
    },
    {
      id: "access",
      ok: f.groupsWithModule > 0,
      label: "At least one group may use it",
      detail: "Give a group the Assistant module (Admin > Groups). The admin group always has it.",
    },
    {
      id: "budget",
      ok: f.monthlyBudget > 0 || free,
      label: "A monthly budget is set (or the model costs nothing)",
      detail: "Set the prices and a monthly budget, or set both prices to 0 for a model you run yourself.",
    },
    {
      id: "privacy",
      ok: !!f.privacy && f.privacy.destination === f.destination,
      label: "The privacy notice is acknowledged",
      detail: f.privacy && f.privacy.destination !== f.destination ? `It was acknowledged for ${f.privacy.destination}; the destination has changed.` : "Read and acknowledge what is sent.",
    },
  ];
  return { ready: items.every((i) => i.ok), items };
}

/** Cost of one answer in the site's currency, from the admin's prices per million tokens. */
export function assistantCost(inputTokens: number, outputTokens: number, priceIn: number, priceOut: number): number {
  return (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000;
}

/** Why a question may not run now, or null. Budget 0 = no cap (allowed only when the model is free, see readiness). */
export function assistantLimitProblem(f: {
  questionsLastMinute: number;
  questionsToday: number;
  monthCost: number;
  ratePerMin: number;
  daily: number;
  budget: number;
}): string | null {
  if (f.ratePerMin > 0 && f.questionsLastMinute >= f.ratePerMin) return "That is a lot of questions in a minute. Try again in a moment.";
  if (f.daily > 0 && f.questionsToday >= f.daily) return "You have asked as many questions as one person may today. It resets at midnight.";
  if (f.budget > 0 && f.monthCost >= f.budget) return "This month's budget for the assistant is used up. A site admin can raise it.";
  return null;
}

/** Tool paths the assistant is never given, whatever the person may do (docs/assistant.md section 7.3). */
const DENIED_PATH = /^\/(admin|audit|settings|backups|users|groups|me\/api-tokens|me\/sessions|me\/push|auth|alert-channels|cisco\/switches\/:id\/backups|planning-center)(\/|$)/;

/** Whether a read tool of the MCP catalogue may be offered to the assistant (by its route path). */
export function assistantMayUseRoute(path: string): boolean {
  return !DENIED_PATH.test(path);
}
