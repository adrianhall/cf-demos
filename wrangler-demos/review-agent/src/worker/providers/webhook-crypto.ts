import { timingSafeEqual } from "node:crypto";

/**
 * Compute a lowercase hex-encoded HMAC-SHA-256 digest, for verifying GitHub's
 * `X-Hub-Signature-256` webhook header (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration").
 * GitLab needs no equivalent -- it sends its shared secret verbatim as `X-Gitlab-Token` instead
 * of signing the body.
 *
 * @param secret The shared webhook secret (`env.GITHUB_WEBHOOK_SECRET`).
 * @param message The exact raw request body the signature was computed over.
 * @returns The hex-encoded digest, with no `sha256=` prefix -- the caller prepends that itself
 * before comparing against the header value.
 */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Compare two strings in constant time, for verifying a webhook signature/token without a plain
 * `===` (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration": "never a plain `===` on the hex
 * digest"). Used for both GitHub's computed-signature comparison and GitLab's shared-token
 * comparison.
 *
 * @param a The first string (typically the header value received from the provider).
 * @param b The second string (typically the value computed/configured locally).
 * @returns Whether `a` and `b` are exactly equal. A length mismatch still runs
 * `node:crypto`'s `timingSafeEqual` once, against `a` compared with itself, so a mismatched
 * length returns through the exact same call shape as a mismatched-content comparison rather
 * than a visibly cheaper early return.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) {
    timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return timingSafeEqual(aBytes, bBytes);
}
