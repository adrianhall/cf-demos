import type { ModelAdapterId, ModelDescriptor } from "../../../models";
import * as cfNative from "./cf-native";
import * as openAiChat from "./openai-chat";
import type { AdapterParams, AiChatMessage } from "./types";

export type { AdapterParams, AiChatMessage, NormalizedChunk } from "./types";

/** The registry of adapter modules, keyed by `ModelDescriptor.adapter` (`src/models.ts`). */
const ADAPTERS = {
  "cf-native": cfNative,
  "openai-chat": openAiChat,
} as const satisfies Record<ModelAdapterId, unknown>;

/**
 * Open an upstream Workers AI stream for `descriptor`, dispatching to its declared adapter.
 *
 * This is the **one** unavoidable polymorphic boundary in the adapter layer: each adapter
 * module's own `run()` keeps a narrow model-ID union and input type (see `cf-native.ts` and
 * `openai-chat.ts`), fully exercised by that module's own colocated tests without any cast. Here,
 * `descriptor.id` and the adapter-specific `input` are widened to `never` for one dispatch call.
 * This is safe — not merely convenient — because `descriptor` is only ever a `MODEL_CATALOG`
 * entry (`src/models.ts`), whose `adapter` field is authored to name exactly the module whose
 * model-ID union contains that entry's `id`; the two are not independently editable.
 *
 * @param ai The `AI` binding.
 * @param descriptor The resolved model descriptor (`src/worker/chat/validation.ts`).
 * @param messages Full conversation including the server-owned system prompt.
 * @param params Temperature and output-token-limit, already clamped to `descriptor`'s bounds.
 * @param signal Optional abort signal propagated to the adapter's `env.AI.run()` call.
 * @returns A promise for the model's raw SSE byte stream. Rejects with Workers AI's own error for
 * a before-first-byte failure; the caller (`src/worker/chat/inference.ts`) maps that to an RFC
 * 9457 response before opening any stream.
 */
export async function openInferenceStream(
  ai: Ai,
  descriptor: ModelDescriptor,
  messages: readonly AiChatMessage[],
  params: AdapterParams,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  const adapter = ADAPTERS[descriptor.adapter];
  const input = adapter.buildInput(messages, params);
  return adapter.run(ai, descriptor.id as never, input as never, signal);
}

/**
 * Read one parsed chunk using `descriptor`'s declared adapter.
 *
 * @param descriptor The resolved model descriptor.
 * @param parsedChunk One already-JSON-parsed upstream SSE frame.
 * @returns The normalized chunk (see `./types.ts`'s `NormalizedChunk`).
 */
export function readInferenceChunk(
  descriptor: ModelDescriptor,
  parsedChunk: unknown,
): ReturnType<(typeof cfNative)["readChunk"]> {
  return ADAPTERS[descriptor.adapter].readChunk(parsedChunk);
}
