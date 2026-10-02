/**
 * @file Tests for the derived job identifier, which is this panel's entire ownership mechanism.
 *   There is no stored owner column to compare against: the identifier is a keyed hash of the
 *   verified email and the run identifier, so a visitor asking after someone else's run derives a
 *   different identifier and finds nothing. That makes two properties load-bearing — stability and
 *   separation — and both are asserted here rather than left to the route tests, because a
 *   regression in either would read as a `404` rather than as a security failure.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveMediaJobId,
  GENERATED_VIDEO_PREFIX,
  videoObjectKey
} from '../../../src/worker/domain/media-job-identity';

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Stand-in for the Access audience tag used as keying material.
 */
const KEY = 'a'.repeat(64);

describe('deriveMediaJobId', () => {
  it('derives the same identifier for the same identity and run', async () => {
    // The job is started by one request and read by many later ones, so instability here would
    // strand every job as unreadable the moment it was created.
    const first = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);
    const second = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);

    expect(first).toBe(second);
  });

  it('derives a different identifier for a different identity', async () => {
    // This is the ownership check. Two visitors using the same run identifier must not reach one
    // another's job.
    const alice = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);
    const bob = await deriveMediaJobId('bob@example.com', RUN_ID, KEY);

    expect(alice).not.toBe(bob);
  });

  it('derives a different identifier for a different run', async () => {
    const first = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);
    const second = await deriveMediaJobId(
      'alice@example.com',
      '8d0f7780-8536-51ef-a55c-f18fd2fa1bf8',
      KEY
    );

    expect(first).not.toBe(second);
  });

  it('derives a different identifier under a different key', async () => {
    // The key is what stops the identifier being computable by anyone who knows an email and a run
    // identifier — and a run identifier travels to the browser.
    const first = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);
    const second = await deriveMediaJobId('alice@example.com', RUN_ID, 'b'.repeat(64));

    expect(first).not.toBe(second);
  });

  it('separates fields so a shifted boundary cannot collide', async () => {
    // Without a separator, `("ab", "c")` and `("a", "bc")` would hash identically — and a collision
    // here means one visitor reading another's job.
    const left = await deriveMediaJobId('ab@example.com', RUN_ID, KEY);
    const right = await deriveMediaJobId('ab@example.co', `m${RUN_ID}`, KEY);

    expect(left).not.toBe(right);
  });

  it('produces an identifier a Workflow instance ID accepts', async () => {
    // Workflow instance IDs permit alphanumerics, dashes, and underscores. Hex satisfies that, and
    // asserting it here means a future change of encoding fails locally rather than at deploy time.
    const id = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);

    expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ['an empty email', '', RUN_ID, KEY],
    ['an empty run identifier', 'alice@example.com', '', KEY],
    ['an empty key', 'alice@example.com', RUN_ID, '']
  ])('refuses %s', async (_label, email, runId, key) => {
    // Each absence silently weakens the derivation rather than breaking it: an empty key reduces
    // this to a guessable digest, and an empty email makes every visitor's jobs collide. Failing
    // loudly is the only safe direction.
    await expect(deriveMediaJobId(email, runId, key)).rejects.toThrow();
  });
});

describe('videoObjectKey', () => {
  it('places every key under the generated-video prefix', async () => {
    const id = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);

    expect(videoObjectKey(id)).toBe(`${GENERATED_VIDEO_PREFIX}${id}`);
    expect(videoObjectKey(id).startsWith(GENERATED_VIDEO_PREFIX)).toBe(true);
  });

  it('inherits the identifier’s unguessability', async () => {
    // Someone who knows a run identifier still cannot name the object, because the key is built
    // from the derived identifier rather than from the run identifier directly.
    const id = await deriveMediaJobId('alice@example.com', RUN_ID, KEY);

    expect(videoObjectKey(id)).not.toContain(RUN_ID);
  });

  it('refuses an empty identifier', () => {
    // Would otherwise produce the bare prefix as a key, which every such call would then share.
    expect(() => videoObjectKey('')).toThrow();
  });
});
