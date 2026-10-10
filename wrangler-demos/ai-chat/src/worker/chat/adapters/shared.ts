import { valueOrDefault } from "@adrianhall/cloudflare-toolkit";
import type { UsageInfo } from "../../../chat-protocol";
import type { NormalizedChunk } from "./types";

/**
 * Raw token-usage object observed on every Workers AI streaming chunk (both adapters, every
 * catalog model — see docs/DECISIONS.md #10). Fields are optional because the very first chunk
 * of a turn reports only `prompt_tokens`, and some intermediate chunks omit the object shape
 * entirely.
 */
export interface RawUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

/**
 * Normalize a raw Workers AI usage object to this Worker's `UsageInfo` shape.
 *
 * @param usage Raw usage object from one parsed chunk, if present.
 * @returns The normalized shape, or `undefined` when `usage` is absent. Missing numeric fields
 * default to `0` rather than propagating `undefined`, since `UsageInfo`'s fields are required.
 */
export function normalizeUsage(
  usage: RawUsage | undefined,
): UsageInfo | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: valueOrDefault(usage.prompt_tokens, 0),
    completionTokens: valueOrDefault(usage.completion_tokens, 0),
    totalTokens: valueOrDefault(usage.total_tokens, 0),
  };
}

/** One choice entry in an OpenAI-Chat-Completions-shaped streaming delta chunk. */
export interface OpenAiStyleChoice {
  readonly delta?: {
    readonly content?: string | null;
    readonly reasoning_content?: string | null;
  };
  readonly finish_reason?: string | null;
}

/**
 * The OpenAI-Chat-Completions-shaped streaming delta chunk. Verified by a live spike
 * (docs/DECISIONS.md #10) to be what **four of the five** catalog models actually stream —
 * including Granite and Llama 4 Scout, both typed with the permissive `cf-native`-family input
 * type. Only DeepSeek R1 Distill streams the plain `{ response }` shape its input type's name
 * suggests.
 */
export interface OpenAiStyleChunk {
  readonly choices?: readonly OpenAiStyleChoice[];
  readonly usage?: RawUsage;
  // An index signature is required only so this type can be the target of the `chunk is
  // OpenAiStyleChunk` predicate below, whose asserted type TypeScript requires to be assignable
  // to the (Record<string, unknown>-shaped) parameter type it narrows.
  readonly [key: string]: unknown;
}

/** A loosely-typed view of one parsed chunk, used only to duck-type which shape arrived. */
type UnknownChunk = Record<string, unknown>;

/**
 * Detect the OpenAI-Chat-Completions-shaped chunk by the presence of a `choices` array. The one
 * terminal chunk every model emits immediately before `[DONE]` (`{ response: "", usage }`) has no
 * `choices` key at all, so this correctly falls through to the plain-`response` path for it —
 * including for DeepSeek, whose *entire* stream lacks `choices`.
 *
 * @param chunk One already-JSON-parsed chunk.
 * @returns `true` when `chunk.choices` is an array (possibly empty).
 */
export function isOpenAiStyleChunk(
  chunk: UnknownChunk,
): chunk is OpenAiStyleChunk {
  return Array.isArray(chunk.choices);
}

/**
 * Read one OpenAI-Chat-Completions-shaped chunk's first choice into a {@link NormalizedChunk}.
 * Shared by both adapters (docs/05-AI-CHAT.md, "Model Adapters") since both may receive this
 * physical shape — only whether `reasoning_content` is honored differs between them.
 *
 * @param chunk A chunk already identified as OpenAI-Chat-Completions-shaped.
 * @param options.includeReasoning When `true`, populate `thinkingDelta` from
 * `choices[0].delta.reasoning_content`. The `cf-native` adapter passes `false`: none of its three
 * models ever report this field, and DeepSeek's reasoning is handled downstream by
 * `src/worker/chat/reasoning.ts` instead.
 * @returns The normalized chunk. An empty choices array (observed immediately before the
 * terminal usage-only frame) yields only `usage`, if present.
 */
export function readOpenAiStyleChunk(
  chunk: OpenAiStyleChunk,
  options: { readonly includeReasoning: boolean },
): NormalizedChunk {
  const result: NormalizedChunk = {};
  const choice = chunk.choices?.[0];

  if (choice?.delta?.content) {
    result.answerDelta = choice.delta.content;
  }
  if (options.includeReasoning && choice?.delta?.reasoning_content) {
    result.thinkingDelta = choice.delta.reasoning_content;
  }
  if (choice?.finish_reason) {
    result.finishReason = choice.finish_reason;
  }

  const usage = normalizeUsage(chunk.usage);
  if (usage) {
    result.usage = usage;
  }

  return result;
}

/**
 * Read the terminal `{ response: "", usage }` frame shared by every catalog model, when it is
 * the plain (non-`choices`) shape. Also handles DeepSeek's ordinary per-token frames, which use
 * this exact shape with a non-empty `response`.
 *
 * @param chunk A chunk already identified as not OpenAI-Chat-Completions-shaped.
 * @returns `answerDelta` set from a non-empty `response`, plus `usage` when present. Both are
 * omitted (an empty object) for a chunk with neither.
 */
export function readPlainResponseChunk(chunk: UnknownChunk): NormalizedChunk {
  const result: NormalizedChunk = {};
  const response = chunk.response;
  if (typeof response === "string" && response.length > 0) {
    result.answerDelta = response;
  }
  const usage = normalizeUsage(chunk.usage as RawUsage | undefined);
  if (usage) {
    result.usage = usage;
  }
  return result;
}

/**
 * Duck-type a parsed JSON value as a chunk record, tolerating malformed upstream input instead of
 * throwing mid-stream.
 *
 * @param parsed A value produced by `JSON.parse()` on one SSE `data:` payload.
 * @returns `parsed` as an {@link UnknownChunk} record, or `undefined` when it is not a plain
 * object (for example a stray primitive) and therefore has nothing to read.
 */
export function asChunkRecord(parsed: unknown): UnknownChunk | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as UnknownChunk;
}
