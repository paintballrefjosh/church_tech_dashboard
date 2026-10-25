/**
 * One interface for the assistant's two providers (docs/assistant.md section 4). A session owns its own transcript in
 * the provider's native shape and only ever appends to it, so whatever the provider hands back (Claude's thinking blocks,
 * tool calls) goes back to it unchanged on the next turn.
 */

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmTurn {
  text: string;
  toolCalls: LlmToolCall[];
  inputTokens: number;
  outputTokens: number;
  /** end | tool_use | max_tokens | refusal | other */
  stop: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
}

export interface LlmToolResult {
  id: string;
  content: string;
  isError: boolean;
}

/** One question's conversation with the model. */
export interface LlmSession {
  turn(onText: (delta: string) => void, signal: AbortSignal): Promise<LlmTurn>;
  /** Answer the tool calls of the last turn (all of them, in one message). */
  addToolResults(results: LlmToolResult[]): void;
  /** A plain instruction appended as the user (for "answer now with what you have"). */
  addUserText(text: string): void;
}

export interface LlmClient {
  start(opts: { system: string; history: Array<{ role: "user" | "assistant"; content: string }>; question: string; tools: LlmTool[]; maxTokens: number }): LlmSession;
  describe(): { provider: string; model: string };
}

/** A provider problem, classified, with a message fit to show a person (docs/assistant.md section 4: errors). */
export class LlmError extends Error {
  constructor(
    readonly kind: "unauthorised" | "rate_limited" | "model_not_found" | "context_too_long" | "timeout" | "unreachable" | "bad_response" | "refused",
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
