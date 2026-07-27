import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { SendMessageInput } from "./types";

const MAX_MESSAGE_LENGTH = 2_000;
/** Matches any Unicode control character (category `Cc`), rejecting unsafe message bodies. */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * Validate a text WebSocket frame before it becomes durable channel history.
 *
 * @param value Incoming WebSocket frame.
 * @returns Strictly validated message input.
 * @throws {ProblemDetailsError} When the frame is binary, malformed, or unsafe.
 */
export function validateMessageInput(
  value: string | ArrayBuffer,
): SendMessageInput {
  if (typeof value !== "string") {
    throw badRequest({ detail: "Messages must be text frames." });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw badRequest({ detail: "Messages must contain valid JSON." });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest({ detail: "Messages must be an object." });
  }

  const input = parsed as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "body")) {
    throw unprocessableContent({ detail: "Only body may be supplied." });
  }
  if (typeof input.body !== "string") {
    throw unprocessableContent({ detail: "body must be a string." });
  }

  const body = input.body.trim();
  if (
    body.length === 0 ||
    body.length > MAX_MESSAGE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(body)
  ) {
    throw unprocessableContent({
      detail:
        "body must be 1 to 2000 characters and cannot contain control characters.",
    });
  }
  return { body };
}
