import { describe, expect, it } from 'vitest';
import {
  generateShareToken,
  SHARE_TOKEN_LENGTH,
  shareTokenDigest,
  validateShareToken
} from '../../src/worker/domain/share-token.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers the share token's domain rules: how a token is minted, how it is reduced to the
 *   digest that is the only form ever persisted, and how a malformed one is reported. These are the
 *   rules the whole sharing feature's security rests on, so they are asserted here — pure, with no
 *   storage and no transport in the way — rather than only observed through an HTTP response.
 */

describe('generateShareToken', () => {
  it('mints a URL-safe token of the documented length', () => {
    expect(generateShareToken()).toMatch(/^[\w-]{43}$/u);
    expect(SHARE_TOKEN_LENGTH).toBe(43);
  });

  // A share token is a bearer capability: anybody holding it may read the diagram. Its only
  // defence is being unguessable, so two tokens must never collide and the value must come from
  // the platform's cryptographic generator rather than `Math.random()`.
  it('mints a different token every time', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateShareToken()));

    expect(tokens.size).toBe(64);
  });

  // Base64url, not base64: the token travels in a URL path, where `+` and `/` would have to be
  // percent-encoded and `=` padding would be noise.
  it('uses no base64 character that a URL would have to encode', () => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      expect(generateShareToken()).not.toMatch(/[+/=]/u);
    }
  });
});

describe('shareTokenDigest', () => {
  // A fixed vector rather than a round trip through the same function: this proves the digest is
  // genuinely SHA-256 hex, which is what the stored column and the KV key are documented to be.
  it('computes the SHA-256 hex digest of the token', async () => {
    await expect(shareTokenDigest('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('produces 64 lowercase hex characters for a real token', async () => {
    await expect(shareTokenDigest(generateShareToken())).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable for one token and different for another', async () => {
    const token = generateShareToken();

    await expect(shareTokenDigest(token)).resolves.toBe(await shareTokenDigest(token));
    await expect(shareTokenDigest(token)).resolves.not.toBe(
      await shareTokenDigest(generateShareToken())
    );
  });

  // The whole point of storing a digest: the stored value must not contain the token it came
  // from, or "digest-only storage" would be a longer spelling of plaintext.
  it('never contains the token it was computed from', async () => {
    const token = generateShareToken();

    expect(await shareTokenDigest(token)).not.toContain(token);
  });
});

describe('validateShareToken', () => {
  it('accepts a freshly minted token', () => {
    const token = generateShareToken();

    expect(validateShareToken(token)).toBe(token);
  });

  // `404`, never `400`: a caller must not be able to tell "that is not even a token" from "that
  // token is unknown" or "that token was revoked", or the format becomes an oracle.
  it.each([
    ['an empty string', ''],
    ['a short value', 'abc'],
    ['a long value', 'a'.repeat(44)],
    ['a path traversal attempt', '../'.repeat(14) + 'x'],
    ['a value carrying base64 padding', `${'a'.repeat(42)}=`]
  ])('refuses %s with 404', (_label, candidate) => {
    expectProblemStatus(() => validateShareToken(candidate), 404);
  });
});
