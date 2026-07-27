import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { CreateChannelInput } from "./types";

const MAX_CHANNEL_NAME_LENGTH = 32;
const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;
const RESERVED_CHANNEL_NAMES = new Set(["api", "channels", "me", "ws"]);

/**
 * Validate and normalize a channel name before it is used as a D1 key or Durable Object name.
 *
 * @param value Candidate channel name.
 * @returns Lowercase, trimmed channel name.
 * @throws {ProblemDetailsError} When the name is malformed, too long, or reserved.
 */
export function validateChannelName(value: unknown): string {
  if (typeof value !== "string") {
    throw unprocessableContent({ detail: "name must be a string." });
  }

  const name = value.trim().toLowerCase();
  if (
    name.length === 0 ||
    name.length > MAX_CHANNEL_NAME_LENGTH ||
    !CHANNEL_NAME_PATTERN.test(name) ||
    RESERVED_CHANNEL_NAMES.has(name)
  ) {
    throw unprocessableContent({
      detail:
        "name must start with a letter and contain only lowercase letters, numbers, or hyphens (maximum 32 characters).",
    });
  }
  return name;
}

/**
 * Validate the narrow JSON payload accepted by the channel creation endpoint.
 *
 * @param value Parsed request JSON.
 * @returns Creation input with a normalized name.
 * @throws {ProblemDetailsError} When the payload is not an object containing only `name`.
 */
export function validateCreateChannelInput(value: unknown): CreateChannelInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "Request body must be an object." });
  }

  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "name")) {
    throw unprocessableContent({ detail: "Only name may be supplied." });
  }
  return { name: validateChannelName(input.name) };
}
