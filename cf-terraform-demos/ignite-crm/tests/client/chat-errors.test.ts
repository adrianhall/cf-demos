/**
 * @file The safe error boundary around Workers AI Gateway failures. Provider failures are not a UI
 *   contract — their messages can include implementation details — but a user can act on a
 *   temporary usage limit, so that one outcome gets a distinct, bounded sentence.
 */

import { describe, expect, it } from 'vitest';
import { presentChatFailure } from '../../src/client/services/chat-errors.ts';

describe('chat failure presentation', () => {
  it('explains an HTTP 429 as a temporary usage limit', () => {
    expect(presentChatFailure({ status: 429 })).toEqual({
      message: 'The assistant has reached its temporary usage limit. Try again shortly.',
      limited: true,
      billing: false
    });
  });

  it('explains an HTTP 402 as a Workers AI billing problem without blaming CRM data', () => {
    expect(presentChatFailure({ status: 402, detail: 'Payment Defaulted' })).toEqual({
      message:
        'The assistant is unavailable because Workers AI billing needs attention. CRM data and actions are unaffected.',
      limited: false,
      billing: true
    });
  });

  it('recognises the bounded limit wording providers commonly return', () => {
    for (const message of [
      'rate limit exceeded',
      'Daily spend quota exceeded',
      'usage limit reached',
      'Gateway spend limit'
    ]) {
      expect(presentChatFailure(new Error(message)).limited, message).toBe(true);
      expect(presentChatFailure(new Error(message)).billing, message).toBe(false);
    }
  });

  it('does not misclassify an ordinary outage as a limit', () => {
    expect(presentChatFailure(new Error('connection reset by peer'))).toEqual({
      message: 'The assistant is unavailable right now. Try again in a moment.',
      limited: false,
      billing: false
    });
  });

  it('never displays an arbitrary thrown value', () => {
    const result = presentChatFailure({ status: 503, detail: 'D1 at internal.example was down' });

    expect(result).toEqual({
      message: 'The assistant is unavailable right now. Try again in a moment.',
      limited: false,
      billing: false
    });
    expect(result.message).not.toContain('internal.example');
  });
});
