/**
 * @file Idempotency key derivation. The property that matters is replay safety: the same turn and
 *   the same tool call must always give the same key, so an approval replayed after a reconnect is
 *   a replay in the Data Worker rather than a second record (`specs/ignite-crm/05-ai-features.md`
 *   §3.5).
 */

import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey } from '../../../src/application-worker/chat/idempotency.ts';

describe('chat idempotency keys', () => {
  it('is deterministic for one tool call in one turn', () => {
    expect(deriveIdempotencyKey('req-1', 'call-1')).toBe(deriveIdempotencyKey('req-1', 'call-1'));
  });

  it('separates two tool calls in the same turn', () => {
    expect(deriveIdempotencyKey('req-1', 'call-1')).not.toBe(
      deriveIdempotencyKey('req-1', 'call-2')
    );
  });

  it('separates the same tool call in two turns', () => {
    expect(deriveIdempotencyKey('req-1', 'call-1')).not.toBe(
      deriveIdempotencyKey('req-2', 'call-1')
    );
  });
});
