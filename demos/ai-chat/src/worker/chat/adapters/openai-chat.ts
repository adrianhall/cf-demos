import {
  asChunkRecord,
  isOpenAiStyleChunk,
  readOpenAiStyleChunk,
  readPlainResponseChunk,
} from "./shared";
import type { AdapterParams, AiChatMessage, NormalizedChunk } from "./types";

/**
 * The two catalog models typed with the OpenAI-Chat-Completions-style input (`max_completion_tokens`,
 * `stream_options`) — see `src/models.ts`. This union, not a plain `string`, is what keeps
 * {@link run}'s `env.AI.run()` call site narrow.
 */
export type OpenAiChatModelId =
  | "@cf/zai-org/glm-4.7-flash"
  | "@cf/google/gemma-4-26b-a4b-it";

/**
 * The exact input object shape both {@link OpenAiChatModelId} models accept. `messages` is a
 * plain (non-`readonly`) array — matching the generated per-model input types exactly — so this
 * remains assignable to `env.AI.run()`'s parameter without a cast; see {@link buildInput}, which
 * always constructs a fresh mutable array regardless of the caller's own array type.
 */
export interface OpenAiChatInput {
  readonly messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
  readonly max_completion_tokens: number;
  readonly temperature: number;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
}

/**
 * Build the input for an {@link OpenAiChatModelId} model.
 *
 * `stream_options.include_usage` is always sent, per these models' documented contract — even
 * though the live spike observed the terminal usage frame appear regardless of this flag on this
 * account (see docs/DECISIONS.md #10). Sending it is the documented, forward-compatible choice
 * and costs nothing; do not remove it on the assumption usage arrives unconditionally on every
 * account/gateway version.
 *
 * @param messages Full conversation including the server-owned system prompt.
 * @param params Temperature and output-token-limit, already clamped to the selected model's
 * descriptor bounds by `src/worker/chat/validation.ts`.
 * @returns The input object, ready for {@link run}.
 */
export function buildInput(
  messages: readonly AiChatMessage[],
  params: AdapterParams,
): OpenAiChatInput {
  return {
    // A fresh mutable array/objects, regardless of the caller's own array type — see this
    // interface's docs for why that matters for assignability to env.AI.run()'s parameter.
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_completion_tokens: params.maxTokens,
    temperature: params.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
}

/**
 * Call `env.AI.run()` for an {@link OpenAiChatModelId} model.
 *
 * @param ai The `AI` binding.
 * @param modelId One of {@link OpenAiChatModelId}.
 * @param input Input built by {@link buildInput}.
 * @param signal Optional abort signal, wired to the outgoing response stream's cancellation
 * (`src/worker/chat/stream.ts`) so an abandoned generation actually stops upstream.
 * @returns A promise for the raw SSE byte stream. Rejects with Workers AI's own error for a
 * before-first-byte failure (invalid input, an unavailable model); the caller
 * (`src/worker/chat/inference.ts`) maps that to an RFC 9457 response before opening any stream.
 */
export async function run(
  ai: Ai,
  modelId: OpenAiChatModelId,
  input: OpenAiChatInput,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  return ai.run(modelId, input, { signal });
}

/**
 * Read one parsed chunk from an {@link OpenAiChatModelId} model's stream.
 *
 * Both catalog models in this adapter always stream the OpenAI-Chat-Completions delta shape, with
 * `thinkingDelta` populated directly from `choices[0].delta.reasoning_content` when present — no
 * text parsing is needed, unlike DeepSeek R1's inline `<think>` markers
 * (`src/worker/chat/reasoning.ts`). The one exception is the terminal `{ response: "", usage }`
 * frame shared by every catalog model regardless of adapter (docs/DECISIONS.md #10), handled by
 * the same plain-`response` fallback the `cf-native` adapter uses.
 *
 * @param parsedChunk One already-JSON-parsed upstream SSE frame.
 * @returns The normalized chunk. An unparseable or unexpected shape yields an empty object rather
 * than throwing, so one malformed frame cannot abort an otherwise-healthy stream.
 */
export function readChunk(parsedChunk: unknown): NormalizedChunk {
  const chunk = asChunkRecord(parsedChunk);
  if (!chunk) {
    return {};
  }
  return isOpenAiStyleChunk(chunk)
    ? readOpenAiStyleChunk(chunk, { includeReasoning: true })
    : readPlainResponseChunk(chunk);
}
