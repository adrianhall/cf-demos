import { describe, expect, it } from 'vitest';
import { validateDirectoryPage } from '../../src/worker/domain/user-validation.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers the administrative directory's pagination rules. Every case here is one a happy path
 *   never reaches — an omitted parameter, a hostile one, one past the ceiling — because the happy
 *   path is the one case that cannot go wrong.
 */

describe('defaults', () => {
  // Both parameters are optional, so the common request is one that sends neither: the table's
  // first load.
  it('reads the first page when neither parameter is given', () => {
    expect(validateDirectoryPage({})).toEqual({ limit: 20, offset: 0 });
  });

  it('keeps the default limit when only an offset is given', () => {
    expect(validateDirectoryPage({ offset: '40' })).toEqual({ limit: 20, offset: 40 });
  });

  it('keeps the first offset when only a limit is given', () => {
    expect(validateDirectoryPage({ limit: '5' })).toEqual({ limit: 5, offset: 0 });
  });
});

describe('accepted values', () => {
  it('accepts an explicit window', () => {
    expect(validateDirectoryPage({ limit: '10', offset: '30' })).toEqual({
      limit: 10,
      offset: 30
    });
  });

  // Zero is a meaningful offset — it is the first page — and must not be confused with "absent".
  it('accepts a zero offset', () => {
    expect(validateDirectoryPage({ offset: '0' })).toMatchObject({ offset: 0 });
  });

  it('accepts the largest permitted limit', () => {
    expect(validateDirectoryPage({ limit: '100' })).toMatchObject({ limit: 100 });
  });
});

describe('refusals', () => {
  // Rejected rather than parsed leniently. `Number.parseInt` would read `12abc` as 12 and discard
  // the rest, which silently answers a request the caller did not make.
  it.each([
    ['a trailing-garbage value', '12abc'],
    ['a decimal', '1.5'],
    ['a negative number', '-1'],
    ['a value with surrounding whitespace', ' 7 '],
    ['an empty value', ''],
    ['a word', 'all']
  ])('refuses %s for limit', (_description, limit) => {
    expectProblemStatus(() => validateDirectoryPage({ limit }), 422);
  });

  it.each([
    ['a trailing-garbage value', '12abc'],
    ['a negative number', '-5'],
    ['an empty value', '']
  ])('refuses %s for offset', (_description, offset) => {
    expectProblemStatus(() => validateDirectoryPage({ offset }), 422);
  });

  // A page of nothing is not a page, and a client asking for one has made a mistake worth
  // reporting rather than one worth answering with an empty list that looks like "no users".
  it('refuses a zero limit', () => {
    expectProblemStatus(() => validateDirectoryPage({ limit: '0' }), 422);
  });

  // Refused rather than clamped. Clamping would answer a request for 500 rows with 100 and no
  // indication it had done so, which a paginating client reads as "that was the last page".
  it('refuses a limit above the ceiling rather than clamping it', () => {
    expectProblemStatus(() => validateDirectoryPage({ limit: '101' }), 422);
  });

  it('names the offending parameter in the refusal', () => {
    try {
      validateDirectoryPage({ offset: 'nonsense' });
      expect.unreachable('expected the call to throw');
    } catch (error) {
      expect((error as { problemDetails: { detail?: string } }).problemDetails.detail).toContain(
        'offset'
      );
    }
  });
});
