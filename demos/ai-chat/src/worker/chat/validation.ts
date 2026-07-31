import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { ChatMessage } from "../../chat-protocol";
import { findModel, type ModelDescriptor } from "../../models";

/**
 * The server-owned system prompt sent as the first message to every model on every turn. A
 * client-supplied `system` role is rejected by {@link validateChatRequest} precisely so a caller
 * can never redefine or append to this — it is a constant in this module, not request input.
 */
export const SYSTEM_PROMPT =
  "You are a helpful, concise assistant in the Cloudflare Workers AI Model Playground, a " +
  "demonstration of streaming inference over the Workers AI binding. Answer directly and " +
  "avoid unnecessary preamble.";

/** Maximum accepted length of one message's `content`, in characters. */
const MAX_MESSAGE_LENGTH = 4_000;

/** Maximum accepted total `content` length across every message in one request, in characters. */
const MAX_TOTAL_CHARACTERS = 24_000;

/** Maximum accepted number of messages in one request. */
const MAX_MESSAGE_COUNT = 40;

/** A validated, clamped `/api/chat` request, ready to hand to `src/worker/chat/inference.ts`. */
export interface ValidatedChatRequest {
  /** The resolved catalog entry for the requested model. */
  readonly descriptor: ModelDescriptor;
  /** The validated conversation, excluding the server-owned system prompt. */
  readonly messages: readonly ChatMessage[];
  /** Sampling temperature, clamped to `descriptor.temperature`'s bounds. */
  readonly temperature: number;
  /** Output token limit, clamped to `descriptor.maxOutputTokens`'s bounds. */
  readonly maxTokens: number;
}

/**
 * Validate and clamp a `POST /api/chat` request body before any call to `env.AI.run()`. Every
 * check here runs before the Worker opens an upstream stream, so a rejection is always an
 * ordinary RFC 9457 JSON response — never an in-band `error` frame (see docs/05-AI-CHAT.md,
 * "Streaming Protocol").
 *
 * @param value Parsed JSON request body.
 * @returns The validated request, with `temperature`/`maxTokens` clamped — never rejected — to
 * the selected model's descriptor bounds, since those bounds genuinely differ per model (see
 * docs/DECISIONS.md #10).
 * @throws {ProblemDetailsError} `400` when the body is not an object; `422` for every other
 * validation failure (unknown model, empty/oversized/malformed messages, a `system` role, a
 * conversation not ending in a `user` turn, or a non-numeric `temperature`/`maxTokens`).
 */
export function validateChatRequest(value: unknown): ValidatedChatRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "Request body must be an object." });
  }

  const descriptor = validateModel(Reflect.get(value, "model"));
  const messages = validateMessages(Reflect.get(value, "messages"));
  const temperature = clampTemperature(
    descriptor,
    Reflect.get(value, "temperature"),
  );
  const maxTokens = clampMaxTokens(descriptor, Reflect.get(value, "maxTokens"));

  return { descriptor, messages, temperature, maxTokens };
}

/**
 * Resolve `model` by exact match against `src/models.ts`'s catalog.
 *
 * @param value Candidate `model` field from the request body.
 * @returns The matching descriptor.
 * @throws {ProblemDetailsError} `422` when `value` is not a string, or is not an exact member of
 * the catalog. Never partially matches or falls back to a default model.
 */
function validateModel(value: unknown): ModelDescriptor {
  if (typeof value !== "string") {
    throw unprocessableContent({
      detail: "model is required and must be a string.",
    });
  }
  const descriptor = findModel(value);
  if (!descriptor) {
    throw unprocessableContent({
      detail: "model must be an exact ID from the catalog.",
    });
  }
  return descriptor;
}

/**
 * Validate the conversation array: non-empty, within the message-count and character caps,
 * every entry shaped as `{ role: "user" | "assistant", content: string }`, and the last message
 * a `user` turn.
 *
 * @param value Candidate `messages` field from the request body.
 * @returns The validated, role-narrowed conversation.
 * @throws {ProblemDetailsError} `422` for any shape or cap violation, including a client-supplied
 * `system` role — the system prompt is a server-owned constant ({@link SYSTEM_PROMPT}), never
 * request input.
 */
function validateMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw unprocessableContent({
      detail: "messages must be a non-empty array.",
    });
  }
  if (value.length > MAX_MESSAGE_COUNT) {
    throw unprocessableContent({
      detail: `messages must contain at most ${MAX_MESSAGE_COUNT} entries.`,
    });
  }

  let totalCharacters = 0;
  const messages = value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw unprocessableContent({
        detail: `messages[${index}] must be an object.`,
      });
    }

    const role = Reflect.get(entry, "role");
    if (role !== "user" && role !== "assistant") {
      throw unprocessableContent({
        detail:
          `messages[${index}].role must be "user" or "assistant". ` +
          'A client-supplied "system" role is not accepted.',
      });
    }

    const content = Reflect.get(entry, "content");
    if (typeof content !== "string" || content.length === 0) {
      throw unprocessableContent({
        detail: `messages[${index}].content must be a non-empty string.`,
      });
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw unprocessableContent({
        detail: `messages[${index}].content exceeds the ${MAX_MESSAGE_LENGTH} character limit.`,
      });
    }

    totalCharacters += content.length;
    return { role, content } satisfies ChatMessage;
  });

  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    throw unprocessableContent({
      detail: `The conversation exceeds the ${MAX_TOTAL_CHARACTERS} total character limit.`,
    });
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "user") {
    throw unprocessableContent({
      detail: 'The last message must have role "user".',
    });
  }

  return messages;
}

/**
 * Clamp a candidate `temperature` to `descriptor.temperature`'s bounds.
 *
 * @param descriptor The resolved model descriptor.
 * @param value Candidate `temperature` field from the request body.
 * @returns `descriptor.temperature.default` when `value` is omitted, otherwise `value` clamped
 * into `[descriptor.temperature.min, descriptor.temperature.max]`.
 * @throws {ProblemDetailsError} `422` when `value` is present but not a finite number.
 */
function clampTemperature(descriptor: ModelDescriptor, value: unknown): number {
  if (value === undefined) {
    return descriptor.temperature.default;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw unprocessableContent({
      detail: "temperature must be a finite number.",
    });
  }
  return Math.min(
    Math.max(value, descriptor.temperature.min),
    descriptor.temperature.max,
  );
}

/**
 * Clamp a candidate `maxTokens` to `descriptor.maxOutputTokens`'s bounds.
 *
 * @param descriptor The resolved model descriptor.
 * @param value Candidate `maxTokens` field from the request body.
 * @returns `descriptor.maxOutputTokens.default` when `value` is omitted, otherwise `value`
 * clamped into `[1, descriptor.maxOutputTokens.max]`.
 * @throws {ProblemDetailsError} `422` when `value` is present but not a positive integer.
 */
function clampMaxTokens(descriptor: ModelDescriptor, value: unknown): number {
  if (value === undefined) {
    return descriptor.maxOutputTokens.default;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw unprocessableContent({ detail: "maxTokens must be an integer." });
  }
  return Math.min(Math.max(value, 1), descriptor.maxOutputTokens.max);
}
