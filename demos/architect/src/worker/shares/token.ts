/** Number of cryptographically random bytes used to generate a share token (256 bits). */
const TOKEN_BYTE_LENGTH = 32;

/**
 * Exact character length of a well-formed, unpadded base64url share token — 32 bytes
 * base64url-encoded without the trailing `=` padding {@link generateShareToken} strips.
 */
export const SHARE_TOKEN_LENGTH = 43;

/** RFC 4648 §5 base64url alphabet, matching {@link generateShareToken}'s output shape. */
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SHARE_TOKEN_LENGTH}}$`, "u");

/**
 * Generate a fresh, high-entropy public share token.
 *
 * Mirrors `../invitations/token.ts`'s invitation-token generation exactly, kept as a separate
 * module rather than a shared import so a future change to one capability's shape (length,
 * encoding) can never silently affect the other's — the two are unrelated capabilities that
 * happen to use the same construction. The raw token is a bearer capability: whoever holds it
 * can view (never edit) one diagram's most recently published snapshot
 * (`./repository.ts`'s `publish()`/`resolve()`). Callers must return it to the owner and never
 * persist or log it — only its SHA-256 digest ({@link digestShareToken}) is ever stored, in
 * `diagram_shares.token_digest` and as the corresponding `SHARES` KV key.
 *
 * @returns A 43-character base64url string encoding 256 bits of randomness.
 */
export function generateShareToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Compute the SHA-256 digest of a raw share token, hex-encoded.
 *
 * @param token Raw token, typically from a `POST /shared/resolve` request body.
 * @returns Lowercase hex-encoded digest, matching `diagram_shares.token_digest`'s stored shape
 * and the `SHARES` KV namespace's key shape.
 */
export async function digestShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hexEncode(new Uint8Array(digest));
}

/**
 * Check whether a candidate string has the exact shape {@link generateShareToken} produces.
 *
 * A cheap shape check only, performed before ever hashing or looking up a candidate token — it
 * rejects a value that could not possibly be a real share token (wrong length or character set)
 * without touching KV, R2, or D1. It is deliberately blind to whether any such token was ever
 * actually issued or is still active; `./repository.ts`'s `resolve()` decides that.
 *
 * @param value Candidate token, typically from an untrusted, unauthenticated request body.
 * @returns Whether `value` has share-token shape.
 */
export function isWellFormedShareToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Encode raw bytes as unpadded base64url text. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

/** Encode raw bytes as lowercase hex text. */
function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
