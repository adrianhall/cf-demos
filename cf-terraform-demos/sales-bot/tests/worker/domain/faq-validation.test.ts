import { describe, expect, it } from 'vitest';
import {
  validateCreateFaqInput,
  validateFaqId,
  validateUpdateFaqInput
} from '../../../src/worker/domain/faq-validation';

/**
 * Assert that a call fails with a particular RFC 9457 status.
 *
 * @param call Work expected to throw.
 * @param status Expected problem-details status.
 * @returns Nothing; it asserts.
 */
function expectStatus(call: () => unknown, status: number): void {
  try {
    call();
  } catch (reason: unknown) {
    const problem = reason as { problemDetails?: { status?: number } };
    expect(problem.problemDetails?.status).toBe(status);
    return;
  }
  throw new Error(`Expected a problem-details error with status ${status}.`);
}

const VALID = { question: 'What is D1?', answer: 'A SQL database.', audience: 'internal' };

describe('validateCreateFaqInput', () => {
  it('accepts a minimal payload and defaults the product to null', () =>
    expect(validateCreateFaqInput(VALID)).toEqual({
      question: 'What is D1?',
      answer: 'A SQL database.',
      productId: null,
      audience: 'internal'
    }));

  it('omits expiresAt when the caller did not supply it, so the service applies the default', () =>
    expect(Object.hasOwn(validateCreateFaqInput(VALID), 'expiresAt')).toBe(false));

  it('keeps an explicit null expiry, which means the author removed it', () =>
    expect(validateCreateFaqInput({ ...VALID, expiresAt: null }).expiresAt).toBeNull());

  it('normalizes a supplied expiry to ISO-8601', () =>
    expect(validateCreateFaqInput({ ...VALID, expiresAt: '2027-01-01' }).expiresAt).toBe(
      '2027-01-01T00:00:00.000Z'
    ));

  it('trims the question and answer', () =>
    expect(validateCreateFaqInput({ ...VALID, question: '  spaced  ' }).question).toBe('spaced'));

  it.each([null, [], 'text', 7])('rejects %p as a body with 400', (body) =>
    expectStatus(() => validateCreateFaqInput(body), 400)
  );

  it('rejects an unknown field rather than ignoring it', () =>
    expectStatus(() => validateCreateFaqInput({ ...VALID, owner: 'me' }), 422));

  it('rejects an empty question', () =>
    expectStatus(() => validateCreateFaqInput({ ...VALID, question: '   ' }), 422));

  it('rejects an over-long answer', () =>
    expectStatus(() => validateCreateFaqInput({ ...VALID, answer: 'x'.repeat(8_001) }), 422));

  it('rejects an unrecognized audience', () =>
    expectStatus(() => validateCreateFaqInput({ ...VALID, audience: 'secret' }), 422));

  it('rejects a missing audience, because fail-closed means there is no default', () =>
    expectStatus(
      () => validateCreateFaqInput({ question: VALID.question, answer: VALID.answer }),
      422
    ));

  it('rejects a product identifier that is not a slug', () =>
    expectStatus(() => validateCreateFaqInput({ ...VALID, productId: 'AI Gateway' }), 422));

  it('rejects an unparseable expiry', () =>
    expectStatus(() => validateCreateFaqInput({ ...VALID, expiresAt: 'soon' }), 422));
});

describe('validateUpdateFaqInput', () => {
  it('accepts a single changed field', () =>
    expect(validateUpdateFaqInput({ audience: 'public' })).toEqual({ audience: 'public' }));

  it('distinguishes removing the expiry from leaving it alone', () => {
    expect(Object.hasOwn(validateUpdateFaqInput({ expiresAt: null }), 'expiresAt')).toBe(true);
    expect(Object.hasOwn(validateUpdateFaqInput({ audience: 'nda' }), 'expiresAt')).toBe(false);
  });

  it('rejects an empty body, so a no-op cannot be used to probe for identifiers', () =>
    expectStatus(() => validateUpdateFaqInput({}), 422));

  it('rejects a client-set expired status, which only maintenance may write', () =>
    expectStatus(() => validateUpdateFaqInput({ status: 'expired' }), 422));

  it('accepts archiving', () =>
    expect(validateUpdateFaqInput({ status: 'archived' })).toEqual({ status: 'archived' }));

  it('accepts clearing the product to make an FAQ cross-product', () =>
    expect(validateUpdateFaqInput({ productId: null })).toEqual({ productId: null }));
});

describe('validateFaqId', () => {
  it('accepts a UUID', () =>
    expect(validateFaqId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    ));

  it.each(['', 'not-a-uuid', '../../etc/passwd'])(
    'reports %p as 404 rather than a validation error, so the response reveals nothing',
    (id) => expectStatus(() => validateFaqId(id), 404)
  );
});
