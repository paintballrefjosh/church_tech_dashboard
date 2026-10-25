import { Agent } from "undici";
import { LlmError, type LlmClient, type LlmSession, type LlmTurn } from "./llm-client";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * Any `/v1/chat/completions` server (Ollama, llama.cpp, vLLM, LM Studio, OpenRouter ...): streamed, with function calling.
 * The base URL is the admin's (checked by the settings rules: http(s), no credentials, never link-local); no redirect is
 * followed and the key goes in a header.
 */
export class OpenAiCompatLlm implements LlmClient {
  private readonly dispatcher: Agent;

  constructor(private readonly cfg: { apiKey: string; model: string; baseUrl: string; verifyTls: boolean; timeoutMs: number }) {
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.verifyTls } });
  }

  describe() {
    return { provider: "openai_compatible", model: this.cfg.model };
  }

  start(opts: Parameters<LlmClient["start"]>[0]): LlmSession {
    const messages: ChatMessage[] = [
      { role: "system", content: opts.system },
      ...opts.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: opts.question },
    ];
    const tools = opts.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const cfg = this.cfg;
    const dispatcher = this.dispatcher;
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    return {
      async turn(onText, signal): Promise<LlmTurn> {
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              "user-agent": "church-dashboard-assistant",
              ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: cfg.model,
              messages,
              tools: tools.length ? tools : undefined,
              max_tokens: opts.maxTokens,
              stream: true,
              stream_options: { include_usage: true },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]),
            dispatcher,
          } as RequestInit & { dispatcher: Agent });
        } catch (err) {
          const e = err as Error;
          if (e.name === "TimeoutError") throw new LlmError("timeout", "The model server did not answer in time.");
          if (e.name === "AbortError") throw new LlmError("timeout", "Stopped.");
          throw new LlmError("unreachable", "The model server could not be reached.");
        }
        if (res.status === 401 || res.status === 403) throw new LlmError("unauthorised", "The model server refused the key.");
        if (res.status === 404) throw new LlmError("model_not_found", "The model server does not know that model, or the address is wrong.");
        if (res.status === 429) throw new LlmError("rate_limited", "The model server is limiting requests right now.");
        if (res.status >= 300 && res.status < 400) throw new LlmError("bad_response", "The model server answered with a redirect, which is not followed.");
        if (!res.ok || !res.body) {
          const body = (await res.text().catch(() => "")).slice(0, 200);
          throw new LlmError(/context|too long|maximum/i.test(body) ? "context_too_long" : "bad_response", `The model server answered ${res.status}${body ? `: ${body}` : ""}`);
        }

        let text = "";
        let finish = "";
        let inputTokens = 0;
        let outputTokens = 0;
        const calls = new Map<number, { id: string; name: string; args: string }>();
        try {
          for await (const data of sseData(res.body)) {
            if (data === "[DONE]") break;
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
              outputTokens = chunk.usage.completion_tokens ?? outputTokens;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.delta?.content) {
              text += choice.delta.content;
              onText(choice.delta.content);
            }
            for (const tc of choice.delta?.tool_calls ?? []) {
              const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              calls.set(tc.index, cur);
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw new LlmError("timeout", "Stopped.");
          throw new LlmError("bad_response", "The model server's answer could not be read.");
        }

        const toolCalls = [...calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([i, c]) => {
            let input: unknown = {};
            try {
              input = c.args ? JSON.parse(c.args) : {};
            } catch {
              input = { __unparseable: c.args.slice(0, 200) };
            }
            return { id: c.id || `call_${i}`, name: c.name, input, raw: c.args };
          });
        messages.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.raw || "{}" } })) } : {}),
        });
        const stop = toolCalls.length ? "tool_use" : finish === "length" ? "max_tokens" : finish === "stop" ? "end" : finish === "content_filter" ? "refusal" : "end";
        return { text, toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input })), inputTokens, outputTokens, stop };
      },
      addToolResults(results) {
        for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      },
      addUserText(text) {
        messages.push({ role: "user", content: text });
      },
    };
  }
}

/** The `data:` payloads of a server-sent event stream. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
