/** Number of cryptographically random bytes used to generate an invitation token (256 bits). */
const TOKEN_BYTE_LENGTH = 32;

/**
 * Exact character length of a well-formed, unpadded base64url invitation token — 32 bytes
 * base64url-encoded without the trailing `=` padding {@link generateInvitationToken} strips.
 */
export const INVITATION_TOKEN_LENGTH = 43;

/** RFC 4648 §5 base64url alphabet, matching {@link generateInvitationToken}'s output shape. */
const TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${INVITATION_TOKEN_LENGTH}}$`,
  "u",
);

/**
 * Generate a fresh, high-entropy, single-use invitation token.
 *
 * The raw token is a bearer capability: whoever holds it can redeem durable editor access to one
 * diagram (see `./repository.ts`'s `redeem()`). Callers must return it to the owner exactly once
 * and never persist or log it — only its SHA-256 digest ({@link digestInvitationToken}) is ever
 * stored, in `diagram_invites.token_digest`.
 *
 * @returns A 43-character base64url string encoding 256 bits of randomness.
 */
export function generateInvitationToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Compute the SHA-256 digest of a raw invitation token, hex-encoded.
 *
 * @param token Raw token, typically from a redemption request body.
 * @returns Lowercase hex-encoded digest, matching `diagram_invites.token_digest`'s stored shape.
 */
export async function digestInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hexEncode(new Uint8Array(digest));
}

/**
 * Check whether a candidate string has the exact shape {@link generateInvitationToken} produces.
 *
 * This is a cheap shape check only — it rejects a value that could not possibly be a real
 * invitation token (wrong length or character set) before it is ever hashed or looked up in D1.
 * It is deliberately blind to whether any such token was actually issued; that check happens in
 * `./repository.ts`'s `redeem()`.
 *
 * @param value Candidate token, typically from an untrusted request body.
 * @returns Whether `value` has invitation-token shape.
 */
export function isWellFormedInvitationToken(value: string): boolean {
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
