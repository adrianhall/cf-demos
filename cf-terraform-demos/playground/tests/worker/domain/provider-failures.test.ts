/**
 * @file Tests for provider-failure classification and its Workflow-boundary encoding. This module
 *   exists because of a real defect: a Workflow records a thrown error as `{ name, message }`, so a
 *   `ProblemDetailsError`'s status and visitor-facing detail are dropped on the way out of a step.
 *   An account with no AI Gateway credit therefore reached the UI as an unexplained "unexpected
 *   error" — the one failure a visitor can actually resolve, reported as the one thing they cannot
 *   act on. Two properties matter here. The classification has to survive the round trip, and the
 *   encoding has to carry no provider text — otherwise fixing the first problem would create a
 *   disclosure.
 */

import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  classifyProviderFailure,
  decodeFailureReason,
  encodeFailureReason,
  isInsufficientGatewayCredit
} from '../../../src/worker/domain/provider-failures';

describe('isInsufficientGatewayCredit', () => {
  it.each([
    ['the gateway error code', '2021: Insufficient AI Gateway credits'],
    ['the long phrasing', 'Insufficient AI Gateway credits for this request'],
    ['the short phrasing', 'Insufficient AI credits'],
    ['the requirement phrasing', 'AI credits are required to use this model']
  ])('recognises %s', (_label, message) => {
    expect(isInsufficientGatewayCredit(new Error(message))).toBe(true);
  });

  // These are the forms that actually occurred in production and that the first version of this
  // predicate missed. The deployed gateway logs showed every third-party call answering HTTP 402 at
  // zero cost while every Cloudflare-hosted call answered 200 — and none of the phrases above
  // appeared anywhere, so a plainly-billing failure was classified as a generic provider fault.
  it.each([
    ['a bare status prefix', '402: Payment Required'],
    ['the status in a sentence', 'AI request failed with status 402'],
    ['the reason phrase alone', 'Upstream returned Payment Required'],
    ['a JSON-ish body', 'pixverse/v6 failed: {"status":402,"error":"insufficient balance"}']
  ])('recognises HTTP 402 as a billing failure: %s', (_label, message) => {
    expect(isInsufficientGatewayCredit(new Error(message))).toBe(true);
  });

  it('does not read a number that merely contains 402 as a status', () => {
    // Guards the widened matcher: telling someone to top up a funded account over an unrelated
    // fault is worse than the generic message.
    expect(isInsufficientGatewayCredit(new Error('request 1402953 failed'))).toBe(false);
    expect(isInsufficientGatewayCredit(new Error('took 4021ms and timed out'))).toBe(false);
  });

  it.each([
    ['forbidden', '403: Forbidden'],
    ['rate limited', '429: Too Many Requests'],
    ['server error', '500: Internal Server Error']
  ])('does not treat %s as a billing failure', (_label, message) => {
    // Only 402 has an unambiguous payment meaning. The others have several possible causes.
    expect(isInsufficientGatewayCredit(new Error(message))).toBe(false);
  });

  it('recognises the condition one level down a cause chain', () => {
    // The binding wraps provider errors, so the billing condition is frequently not the outermost
    // message.
    const wrapped = new Error('Model execution failed', {
      cause: new Error('2021: Insufficient AI Gateway credits')
    });

    expect(isInsufficientGatewayCredit(wrapped)).toBe(true);
  });

  it.each([
    ['an unrelated provider error', 'upstream 500 from provider'],
    ['a capacity error', 'Model is busy, try again'],
    ['an empty message', '']
  ])('does not claim %s is a billing failure', (_label, message) => {
    // A false positive here would tell a visitor to top up an account over a transient fault, which
    // is worse than the generic message.
    expect(isInsufficientGatewayCredit(new Error(message))).toBe(false);
  });

  it('ignores a non-error value', () => {
    expect(isInsufficientGatewayCredit('2021: Insufficient AI Gateway credits')).toBe(false);
    expect(isInsufficientGatewayCredit(undefined)).toBe(false);
  });
});

describe('classifyProviderFailure', () => {
  it('classifies a billing failure', () => {
    expect(classifyProviderFailure(new Error('2021: Insufficient AI Gateway credits'))).toBe(
      'insufficient-credit'
    );
  });

  it('defaults to a provider failure', () => {
    // The safe direction: an unrecognised cause gets the generic explanation rather than a guess.
    expect(classifyProviderFailure(new Error('something else'))).toBe('provider-failure');
    expect(classifyProviderFailure(undefined)).toBe('provider-failure');
  });

  // The regression test for the real production chain, which two earlier attempts at this fix both
  // missed. The inference client catches the binding error and throws a `ProblemDetailsError`
  // *before* any caller sees it, deliberately discarding the provider's text. So what reaches the
  // Workflow is the sanitised error, not `2021: Insufficient AI Gateway credits` — and classifying
  // by matching text could never work, because the words it looked for had already been removed on
  // purpose. The status is the fact that survives.
  it('classifies the sanitised error the inference client actually throws', () => {
    const sanitised = new ProblemDetailsError({
      status: 503,
      title: 'AI Gateway credits are unavailable',
      detail:
        'This model uses prepaid AI Gateway credits, and this account does not have enough credit '
        + 'for the request. Add AI Gateway credits, then try again.'
    });

    expect(classifyProviderFailure(sanitised)).toBe('insufficient-credit');
  });

  it('classifies a sanitised provider fault as a provider failure', () => {
    // The client raises `502` for everything that is not a billing failure, so the two statuses it
    // emits have to map to the two reasons and nothing else.
    const sanitised = new ProblemDetailsError({
      status: 502,
      title: 'The model could not complete this request',
      detail: 'The AI provider did not return a usable response.'
    });

    expect(classifyProviderFailure(sanitised)).toBe('provider-failure');
  });

  it('reads the status structurally rather than by class identity', () => {
    // `instanceof` answers `false` across a module-duplication boundary, which would silently
    // reintroduce the bug. A plain object of the same shape must classify identically.
    const lookalike = Object.assign(new Error('sanitised'), {
      problemDetails: { status: 503, title: 'AI Gateway credits are unavailable' }
    });

    expect(classifyProviderFailure(lookalike)).toBe('insufficient-credit');
  });

  it('is idempotent over its own encoding', () => {
    // A step's error passes through more than one layer, so classifying an already-classified
    // failure must not downgrade it to generic.
    const encoded = new Error(encodeFailureReason('insufficient-credit'));

    expect(classifyProviderFailure(encoded)).toBe('insufficient-credit');
  });
});

describe('Workflow boundary encoding', () => {
  it.each(['insufficient-credit', 'provider-failure'] as const)(
    'survives a round trip for %s',
    (reason) => {
      // The property the fix depends on: the classification reaches the status route through the
      // only channel a Workflow preserves.
      expect(decodeFailureReason(encodeFailureReason(reason))).toBe(reason);
    }
  );

  it('carries no provider text', () => {
    // Fixing the lost-classification defect must not create a disclosure. The encoded message is a
    // fixed slug, so there is nothing a provider wrote inside it.
    const encoded = encodeFailureReason('insufficient-credit');

    expect(encoded).toBe('playground-failure:insufficient-credit');
    expect(encoded).not.toMatch(/\s/u);
  });

  it('treats a provider’s own message as unclassified', () => {
    // Anything without the marker was written by a provider and must not be shown to a visitor, so
    // it decodes to nothing rather than being matched loosely.
    expect(decodeFailureReason('upstream 500 from internal-host-7 request 0xdeadbeef')).toBe(
      undefined
    );
    expect(decodeFailureReason('')).toBe(undefined);
  });

  it('rejects an unknown slug rather than trusting it', () => {
    expect(decodeFailureReason('playground-failure:something-invented')).toBe(undefined);
  });
});
