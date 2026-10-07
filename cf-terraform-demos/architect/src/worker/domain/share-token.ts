import { notFound } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * @file The share token's own rules: how one is minted, how it is reduced to the digest that is the
 *   only form ever written down, and what a well-formed one looks like. Pure, with no binding and
 *   no transport, so the HTTP API today and the MCP tool layer in a later phase mint and compare
 *   tokens identically rather than each inventing its own scheme. A share token is a **bearer
 *   capability**: whoever holds it may read the diagram it points at, with no identity of any kind.
 *   Two properties follow, and both live here:
 *
 *   - It must be unguessable, so it is 256 bits from the platform's cryptographic generator rather
 *     than anything derived from the diagram, the owner or the clock.
 *   - It must not be recoverable from storage, so only its SHA-256 digest is ever persisted. The
 *     consequence is deliberate and visible in the API: once a token has been handed to its owner,
 *     the server itself can no longer reproduce it, which is why status never returns a URL.
 */

/**
 * Number of random bytes in a raw share token.
 *
 * 256 bits, the same order as a session identifier, because this token is as good as one: it is the
 * entire credential for reading the diagram.
 */
const TOKEN_BYTES = 32;

/**
 * Length of the base64url encoding of {@link TOKEN_BYTES} bytes, unpadded.
 *
 * Exported so a test and the format check below agree on one number rather than two literals that
 * could drift if the byte count ever changed.
 */
export const SHARE_TOKEN_LENGTH = 43;

/**
 * Shape every share token must match: base64url characters only, at exactly the minted length.
 *
 * `\w` covers `A-Z`, `a-z`, `0-9` and `_`; the explicit `-` completes the base64url alphabet.
 * Padding is excluded because {@link generateShareToken} strips it.
 */
const SHARE_TOKEN_PATTERN = new RegExp(String.raw`^[\w-]{${SHARE_TOKEN_LENGTH}}$`, 'u');

/**
 * Mints a cryptographically random, URL-safe share token.
 *
 * Base64url rather than base64: the token travels in a `/s/:token` path, where `+` and `/` would
 * need percent-encoding and `=` padding would be noise a visitor might trim when copying the link.
 *
 * @returns An unpadded base64url string of {@link SHARE_TOKEN_LENGTH} characters.
 */
export function generateShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Reduces a raw token to the lowercase hex SHA-256 digest that is the only form ever stored.
 *
 * The same digest is both the D1 primary key and the KV key, so a token presented by an anonymous
 * caller is looked up by recomputing this value rather than by comparing against anything stored.
 * That is what makes "the raw token is never persisted" a structural property rather than a
 * convention: there is nowhere a raw token could be read back from, including by this application.
 *
 * @param token Raw share token to hash.
 * @returns The lowercase hex-encoded SHA-256 digest, 64 characters.
 */
export async function shareTokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates a share token taken from a request path.
 *
 * A malformed token is reported as `404`, not `400`, for the same reason a malformed diagram id is
 * (`./diagram-validation.ts`): a caller must never be able to distinguish "that is not a token",
 * "no such token" and "that token was revoked". Answering `400` for the first would turn the token
 * format into an oracle, letting a caller filter their guesses before spending a request on them.
 *
 * @param token Candidate token from the request path.
 * @returns The validated token, unchanged.
 * @throws {ProblemDetailsError} `notFound()` (404) when the value is not a well-formed token. The
 *   detail is the same string every other share refusal uses, so the body cannot tell the cases
 *   apart either.
 */
export function validateShareToken(token: string): string {
  if (!SHARE_TOKEN_PATTERN.test(token)) {
    throw notFound({ detail: 'Share link not found or revoked.' });
  }
  return token;
}
