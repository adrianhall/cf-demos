import {
  badRequest,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { LinkInput } from "./types";

const MAX_DESTINATION_LENGTH = 2_048;

/** Shape every internally generated short code must match. */
export const CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/u;

/**
 * Validate and normalize a destination entered by an administrator.
 *
 * @param destination Candidate destination URL.
 * @returns Canonical absolute HTTP(S) URL.
 * @throws {ProblemDetailsError} When the URL is malformed, too long, or unsafe.
 */
export function validateDestination(destination: string): string {
  if (destination.length === 0 || destination.length > MAX_DESTINATION_LENGTH) {
    throw unprocessableContent({
      detail: "destination must be between 1 and 2048 characters.",
    });
  }

  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw unprocessableContent({
      detail: "destination must be an absolute URL.",
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw unprocessableContent({
      detail: "destination must use the HTTP or HTTPS scheme.",
    });
  }

  return url.toString();
}

/**
 * Validate a user-supplied link payload.
 *
 * @param value Parsed JSON body.
 * @returns Validated link input.
 * @throws {ProblemDetailsError} When the body shape is invalid.
 */
export function validateLinkInput(value: unknown): LinkInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }

  const destination = Reflect.get(value, "destination");
  if (typeof destination !== "string") {
    throw unprocessableContent({ detail: "destination is required." });
  }

  return { destination: validateDestination(destination.trim()) };
}

/**
 * Assert that a path parameter is an internally generated URL-safe short code.
 *
 * @param code Candidate code.
 * @returns Validated code.
 * @throws {ProblemDetailsError} When the code has an unsafe shape.
 */
export function validateCode(code: string): string {
  if (!CODE_PATTERN.test(code)) {
    throw notFound({ detail: "Short link not found." });
  }
  return code;
}
