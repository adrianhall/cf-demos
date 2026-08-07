import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { isWellFormedShareToken } from "./token";

/** Validated `POST /shared/resolve` request body. */
export interface ResolveShareInput {
  /** Raw share token, from the public viewer's URL fragment. */
  token: string;
}

/**
 * Validate an untrusted, unauthenticated `POST /shared/resolve` request body.
 *
 * Deliberately returns the same `notFound()` a caller would see for a well-formed but unknown or
 * revoked token (`../routes/shared.ts`) — this endpoint is reachable by anyone with no Access
 * identity at all, so it must never distinguish "malformed" from "unknown" in its response, or
 * an attacker could use that distinction to fingerprint valid-shaped tokens.
 *
 * @param value Untrusted, already JSON-parsed request body.
 * @returns The validated token.
 * @throws {ProblemDetailsError} `notFound()` when `value` is not `{ token: string }` shaped, or
 * `token` does not have well-formed share-token shape.
 */
export function validateResolveShareInput(value: unknown): ResolveShareInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof (value as { token: unknown }).token !== "string"
  ) {
    throw notFound({ detail: "This share link is not valid." });
  }
  const { token } = value as { token: string };
  if (!isWellFormedShareToken(token)) {
    throw notFound({ detail: "This share link is not valid." });
  }
  return { token };
}
