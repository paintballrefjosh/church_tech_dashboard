import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "undici";
import { LlmError, type LlmClient, type LlmSession, type LlmTool, type LlmTurn } from "./llm-client";

/** Models that take the server-side refusal fallback (`fallbacks: "default"`); others would reject the field. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The Claude API through the official SDK, streamed, in a manual tool loop (the loop is the assistant's, which runs the
 * lookups itself). The system prompt and tools are cached (they repeat on every turn). Thinking blocks returned by the
 * model are passed back unchanged: the transcript is append-only.
 */
export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;
  private readonly direct: boolean;

  constructor(private readonly cfg: { apiKey: string; model: string; baseUrl: string; verifyTls: boolean; timeoutMs: number }) {
    this.direct = !cfg.baseUrl;
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      timeout: cfg.timeoutMs,
      maxRetries: 1,
      defaultHeaders: { "user-agent": "church-dashboard-assistant" },
      ...(cfg.verifyTls ? {} : { fetchOptions: { dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as never }),
    });
  }

  describe() {
    return { provider: "anthropic", model: this.cfg.model };
  }

  start(opts: Parameters<LlmClient["start"]>[0]): LlmSession {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...opts.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: opts.question },
    ];
    // Eager input streaming sends tool inputs as they are generated; a gateway or proxy may reject the field, so only direct.
    const tools: Anthropic.Beta.BetaTool[] = opts.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      ...(this.direct ? { eager_input_streaming: true } : {}),
      ...(i === opts.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const fallback = this.direct && FALLBACK_MODELS.has(this.cfg.model);
    const client = this.client;
    const model = this.cfg.model;

    return {
      async turn(onText, signal): Promise<LlmTurn> {
        let message: Anthropic.Beta.BetaMessage;
        try {
          const stream = client.beta.messages.stream(
            {
              model,
              max_tokens: opts.maxTokens,
              system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
              tools,
              messages,
              ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
            },
            { signal },
          );
          stream.on("text", (delta) => onText(delta));
          message = await stream.finalMessage();
        } catch (err) {
          throw classify(err);
        }
        // Append-only: the reply goes back exactly as it came, thinking blocks included.
        messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const toolCalls = message.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const stop =
          message.stop_reason === "end_turn"
            ? "end"
            : message.stop_reason === "tool_use"
              ? "tool_use"
              : message.stop_reason === "max_tokens"
                ? "max_tokens"
                : message.stop_reason === "refusal"
                  ? "refusal"
                  : "other";
        return { text, toolCalls, inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens, stop };
      },
      addToolResults(results) {
        messages.push({
          role: "user",
          content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
        });
      },
      addUserText(text) {
        messages.push({ role: "user", content: text });
      },
    };
  }
}

/** The SDK's typed errors, most specific first, as words a person can act on. */
function classify(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("unauthorised", "The provider refused the API key. Check it in the assistant settings.");
  }
  if (err instanceof Anthropic.NotFoundError) return new LlmError("model_not_found", "The provider does not know that model. Check the model id.");
  if (err instanceof Anthropic.RateLimitError) return new LlmError("rate_limited", "The provider is limiting requests right now. Try again in a minute.");
  if (err instanceof Anthropic.BadRequestError) {
    return /prompt is too long|context/i.test(err.message)
      ? new LlmError("context_too_long", "The question and what was looked up are too long for the model. Ask something narrower.")
      : new LlmError("bad_response", `The provider refused the request: ${err.message.slice(0, 200)}`);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("timeout", "The provider did not answer in time.");
  if (err instanceof Anthropic.APIConnectionError) return new LlmError("unreachable", "The provider could not be reached.");
  if (err instanceof Anthropic.APIUserAbortError) return new LlmError("timeout", "Stopped.");
  if (err instanceof Anthropic.APIError) return new LlmError("unreachable", `The provider failed (${err.status ?? "no status"}).`);
  return new LlmError("bad_response", (err as Error)?.message?.slice(0, 200) ?? "Unknown error");
}
