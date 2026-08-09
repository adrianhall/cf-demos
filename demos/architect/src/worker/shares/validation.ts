import { notFound } from "@adrianhall/cloudflare-toolkit/errors";

/**
 * Shape every share token (`./repository.ts`'s `randomToken()`: 32 random bytes, base64url
 * encoded, unpadded) must match.
 */
const SHARE_TOKEN_PATTERN = /^[\w-]{43}$/u;

/**
 * Assert that a path parameter is a well-formed share token.
 *
 * @param token Candidate token from the request path.
 * @returns The validated token.
 * @throws {ProblemDetailsError} When the token is malformed -- reported identically to "not
 * found" (`404`), matching `../diagrams/validation.ts`'s `validateDiagramId()`: a malformed
 * token, an unknown token, and a revoked token are all indistinguishable to the caller
 * (docs/09-ARCHITECT.md's non-negotiable tests).
 */
export function validateShareToken(token: string): string {
  if (!SHARE_TOKEN_PATTERN.test(token)) {
    throw notFound({ detail: "Share link not found or revoked." });
  }
  return token;
}
