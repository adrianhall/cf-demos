import {
  asChunkRecord,
  isOpenAiStyleChunk,
  readOpenAiStyleChunk,
  readPlainResponseChunk,
} from "./shared";
import type { AdapterParams, AiChatMessage, NormalizedChunk } from "./types";

/**
 * The three catalog models sharing the permissive `AiTextGenerationInput`/`BaseAiTextGeneration`
 * input type (`max_tokens`, no `stream_options`) — see `src/models.ts`. This union, not a plain
 * `string`, is what keeps {@link run}'s `env.AI.run()` call site narrow.
 */
export type CfNativeModelId =
  | "@cf/ibm-granite/granite-4.0-h-micro"
  | "@cf/meta/llama-4-scout-17b-16e-instruct"
  | "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";

/**
 * The exact input object shape all three {@link CfNativeModelId} models accept. `messages` is a
 * plain (non-`readonly`) array — matching the generated per-model input types exactly — so this
 * remains assignable to `env.AI.run()`'s parameter without a cast; see {@link buildInput}, which
 * always constructs a fresh mutable array regardless of the caller's own array type.
 */
export interface CfNativeInput {
  readonly messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
  readonly max_tokens: number;
  readonly temperature: number;
  readonly stream: true;
}

/**
 * Build the input for a {@link CfNativeModelId} model.
 *
 * `max_tokens` defaults to `256` on all three of these models when omitted (verified by spike —
 * see docs/DECISIONS.md #10), silently truncating every answer mid-sentence. It is therefore
 * always sent explicitly here from the caller's already-clamped `params.maxTokens`, never left
 * for the model's own default.
 *
 * @param messages Full conversation including the server-owned system prompt.
 * @param params Temperature and output-token-limit, already clamped to the selected model's
 * descriptor bounds by `src/worker/chat/validation.ts`.
 * @returns The input object, ready for {@link run}.
 */
export function buildInput(
  messages: readonly AiChatMessage[],
  params: AdapterParams,
): CfNativeInput {
  return {
    // A fresh mutable array/objects, regardless of the caller's own array type — see this
    // interface's docs for why that matters for assignability to env.AI.run()'s parameter.
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    stream: true,
  };
}

/**
 * Call `env.AI.run()` for a {@link CfNativeModelId} model.
 *
 * @param ai The `AI` binding.
 * @param modelId One of {@link CfNativeModelId}.
 * @param input Input built by {@link buildInput}.
 * @param signal Optional abort signal, wired to the outgoing response stream's cancellation
 * (`src/worker/chat/stream.ts`) so an abandoned generation actually stops upstream.
 * @returns A promise for the raw SSE byte stream. Rejects with Workers AI's own error for a
 * before-first-byte failure (invalid input, an unavailable model); the caller
 * (`src/worker/chat/inference.ts`) maps that to an RFC 9457 response before opening any stream.
 */
export async function run(
  ai: Ai,
  modelId: CfNativeModelId,
  input: CfNativeInput,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  return ai.run(modelId, input, { signal });
}

/**
 * Read one parsed chunk from a {@link CfNativeModelId} model's stream.
 *
 * Despite these three models sharing one input type, only DeepSeek R1 Distill actually streams
 * the plain `{ response, usage }` shape that type's name suggests — Granite and Llama 4 Scout
 * both stream the OpenAI-Chat-Completions delta shape instead (verified by spike; see
 * docs/DECISIONS.md #10). This function therefore checks for a `choices` array first and falls
 * back to the plain `response` field, so it correctly reads either physical shape without the
 * caller needing to know which one a given model actually uses.
 *
 * `thinkingDelta` is never populated here: none of these three models report a separate
 * reasoning field, and DeepSeek's inline `<think>` markers are split out of `answerDelta`
 * downstream by `src/worker/chat/reasoning.ts`, driven by the descriptor's `reasoning` field —
 * not by this adapter.
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
    ? readOpenAiStyleChunk(chunk, { includeReasoning: false })
    : readPlainResponseChunk(chunk);
}
