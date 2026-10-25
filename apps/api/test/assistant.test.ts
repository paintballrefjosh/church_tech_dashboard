import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantCost,
  assistantDestination,
  assistantLimitProblem,
  assistantMayUseRoute,
  assistantReadiness,
  validateSettingValue,
  type AssistantReadinessFacts,
} from "@church/shared";
import { alternatingHistory } from "../src/assistant/assistant.service";
import { AnthropicLlm } from "../src/assistant/llm/anthropic.client";
import { OpenAiCompatLlm } from "../src/assistant/llm/openai-compat.client";
import { LlmError } from "../src/assistant/llm/llm-client";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const facts = (over: Partial<AssistantReadinessFacts> = {}): AssistantReadinessFacts => ({
  provider: "anthropic",
  model: "claude-opus-5-5",
  baseUrl: "",
  keySet: true,
  fingerprint: "f1",
  lastTest: { fingerprint: "f1", at: "", ok: true, model: "claude-opus-5-5", latencyMs: 1, detail: "" },
  priceIn: 4,
  priceOut: 20,
  monthlyBudget: 50,
  privacy: { userId: "u", name: "A", at: "", destination: "Anthropic (api.anthropic.com)" },
  destination: "Anthropic (api.anthropic.com)",
  groupsWithModule: 1,
  ...over,
});

describe("assistant readiness", () => {
  it("is ready only when every item is green", () => {
    expect(assistantReadiness(facts()).ready).toBe(true);
    const failing = (over: Partial<AssistantReadinessFacts>) => assistantReadiness(facts(over)).items.filter((i) => !i.ok).map((i) => i.id);
    expect(failing({ keySet: false })).toEqual(["provider"]);
    expect(failing({ fingerprint: "changed" })).toEqual(["test"]);
    expect(failing({ monthlyBudget: 0 })).toEqual(["budget"]);
    expect(failing({ monthlyBudget: 0, priceIn: 0, priceOut: 0 })).toEqual([]);
    expect(failing({ privacy: null })).toEqual(["privacy"]);
    expect(failing({ destination: "OpenAI-compatible server (gpu.lan)" })).toEqual(["privacy"]);
  });
  it("names where the data goes", () => {
    expect(assistantDestination("anthropic", "")).toBe("Anthropic (api.anthropic.com)");
    expect(assistantDestination("openai_compatible", "http://gpu.lan:11434/v1")).toBe("OpenAI-compatible server (gpu.lan:11434)");
  });
});

describe("assistant limits, cost and deny-list", () => {
  const base = { questionsLastMinute: 0, questionsToday: 0, monthCost: 0, ratePerMin: 6, daily: 100, budget: 10 };
  it("refuses over the per-minute, per-day and budget limits", () => {
    expect(assistantLimitProblem(base)).toBeNull();
    expect(assistantLimitProblem({ ...base, questionsLastMinute: 6 })).toMatch(/minute/);
    expect(assistantLimitProblem({ ...base, questionsToday: 100 })).toMatch(/today/);
    expect(assistantLimitProblem({ ...base, monthCost: 10 })).toMatch(/budget/);
    expect(assistantLimitProblem({ ...base, budget: 0, monthCost: 999 })).toBeNull();
  });
  it("prices per million tokens", () => {
    expect(assistantCost(1_000_000, 100_000, 4, 20)).toBe(6);
  });
  it("never offers admin, settings, accounts, backups or tokens", () => {
    for (const p of ["/admin/api-tokens", "/audit", "/settings", "/backups/:id", "/users", "/me/api-tokens", "/alert-channels", "/cisco/switches/:id/backups"]) {
      expect(assistantMayUseRoute(p)).toBe(false);
    }
    for (const p of ["/wiki/:id", "/tickets", "/cisco/vlans", "/monitors"]) expect(assistantMayUseRoute(p)).toBe(true);
  });
  it("the server address is checked like any outbound destination", () => {
    expect(validateSettingValue("assistant.base_url", "http://169.254.169.254/v1")).toMatch(/link-local/);
    expect(validateSettingValue("assistant.base_url", "https://u:p@x.example/v1")).toMatch(/API key field/);
    expect(validateSettingValue("assistant.base_url", "http://gpu.lan:11434/v1")).toBeNull();
    expect(validateSettingValue("assistant.provider", "gemini")).not.toBeNull();
  });
});

describe("alternatingHistory", () => {
  it("keeps answered questions only, as pairs", () => {
    const h = alternatingHistory([
      { role: "assistant", content: "orphan" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2 (failed)" },
      { role: "assistant", content: "" },
      { role: "user", content: "q3" },
      { role: "user", content: "q4" },
      { role: "assistant", content: "a4" },
    ]);
    expect(h.map((m) => m.content)).toEqual(["q1", "a1", "q4", "a4"]);
  });
});

const sse = (res: ServerResponse, events: Array<[string | null, unknown]>) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [ev, data] of events) res.write(`${ev ? `event: ${ev}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  res.end();
};

describe("OpenAI-compatible client", () => {
  it("streams text, assembles a tool call from its fragments, and sends the result back as a tool message", async () => {
    const bodies: Array<{ messages: Array<{ role: string }> }> = [];
    const base = await serve((_req, body, res) => {
      bodies.push(JSON.parse(body));
      if (bodies.length === 1) {
        return sse(res, [
          [null, { choices: [{ delta: { content: "Let me " } }] }],
          [null, { choices: [{ delta: { content: "look." } }] }],
          [null, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: '{"qu' } }] } }] }],
          [null, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"vlan"}' } }] }, finish_reason: "tool_calls" }] }],
          [null, { usage: { prompt_tokens: 50, completion_tokens: 7 } }],
          [null, "[DONE]"],
        ]);
      }
      return sse(res, [[null, { choices: [{ delta: { content: "42 VLANs." }, finish_reason: "stop" }] }], [null, "[DONE]"]]);
    });
    const llm = new OpenAiCompatLlm({ apiKey: "", model: "m", baseUrl: `${base}/v1`, verifyTls: true, timeoutMs: 5000 });
    const s = llm.start({ system: "sys", history: [], question: "how many vlans?", tools: [{ name: "search", description: "d", inputSchema: { type: "object" } }], maxTokens: 100 });
    let streamed = "";
    const t1 = await s.turn((d) => (streamed += d), new AbortController().signal);
    expect(streamed).toBe("Let me look.");
    expect(t1).toMatchObject({ stop: "tool_use", inputTokens: 50, outputTokens: 7, toolCalls: [{ id: "c1", name: "search", input: { query: "vlan" } }] });
    s.addToolResults([{ id: "c1", content: "[]", isError: false }]);
    const t2 = await s.turn(() => undefined, new AbortController().signal);
    expect(t2).toMatchObject({ stop: "end", text: "42 VLANs." });
    expect(bodies[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });
  it("a 401 is classified, not passed through", async () => {
    const base = await serve((_r, _b, res) => res.writeHead(401).end("no"));
    const s = new OpenAiCompatLlm({ apiKey: "k", model: "m", baseUrl: base, verifyTls: true, timeoutMs: 5000 }).start({ system: "", history: [], question: "q", tools: [], maxTokens: 10 });
    await expect(s.turn(() => undefined, new AbortController().signal)).rejects.toMatchObject({ kind: "unauthorised" });
  });
});

describe("Anthropic client (the official SDK against a local Messages API stand-in)", () => {
  const usage = { input_tokens: 30, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  it("streams, returns the tool call, and appends the assistant turn unchanged (thinking included)", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }>; system: unknown; tools: Array<Record<string, unknown>> }> = [];
    const base = await serve((req, body, res) => {
      expect(req.headers["x-api-key"]).toBe("sk-test");
      requests.push(JSON.parse(body));
      if (requests.length === 1) {
        return sse(res, [
          ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking." } }],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "search", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"switch"}' } }],
          ["content_block_stop", { type: "content_block_stop", index: 2 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }
      return sse(res, [
        ["message_start", { type: "message_start", message: { id: "m2", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    });
    const llm = new AnthropicLlm({ apiKey: "sk-test", model: "claude-opus-5-5", baseUrl: base, verifyTls: true, timeoutMs: 5000 });
    const s = llm.start({ system: "sys", history: [], question: "q", tools: [{ name: "search", description: "d", inputSchema: { type: "object", properties: { query: { type: "string" } } } }], maxTokens: 100 });
    const t1 = await s.turn(() => undefined, new AbortController().signal);
    expect(t1).toMatchObject({ stop: "tool_use", text: "Checking.", outputTokens: 12, toolCalls: [{ id: "tu1", name: "search", input: { query: "switch" } }] });
    s.addToolResults([{ id: "tu1", content: "[]", isError: false }]);
    expect(await s.turn(() => undefined, new AbortController().signal)).toMatchObject({ stop: "end", text: "Done." });
    const second = requests[1]!;
    const assistantTurn = second.messages[1]!.content as Array<{ type: string; signature?: string }>;
    expect(assistantTurn[0]).toMatchObject({ type: "thinking", signature: "sig-1" });
    expect(second.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu1", content: "[]" }]);
    // Through a base URL (a gateway): no fallback field, no eager streaming; the system prompt is cached.
    expect(requests[0]).not.toHaveProperty("fallbacks");
    expect(requests[0]!.tools[0]).not.toHaveProperty("eager_input_streaming");
    expect(requests[0]!.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
  });
  it("a refused key becomes a plain message", async () => {
    const base = await serve((_r, _b, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    });
    const s = new AnthropicLlm({ apiKey: "bad", model: "claude-opus-5-5", baseUrl: base, verifyTls: true, timeoutMs: 5000 }).start({ system: "", history: [], question: "q", tools: [], maxTokens: 10 });
    const err = await s.turn(() => undefined, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: "unauthorised" });
  });
});
