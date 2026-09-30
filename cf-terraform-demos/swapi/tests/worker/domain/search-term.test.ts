import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_TERM_LENGTH, validateSearchTerm } from '../../../src/worker/domain/search-term';

describe('validateSearchTerm', () => {
  it('returns undefined when no term is supplied', () => {
    // Absent and null must both mean "no filter": GraphQL delivers an omitted optional argument as
    // undefined but an explicitly null one as null, and the statement builders rely on undefined
    // to decide whether to emit a WHERE clause at all.
    expect(validateSearchTerm(undefined)).toBeUndefined();
    expect(validateSearchTerm(null)).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n']
  ])('treats a %s term as no filter', (_label, value) => {
    // Collapsing blank input to "no filter" keeps `search: ""` and `search: null` on one code path
    // instead of making the first one a pointless `LIKE '%%'` scan.
    expect(validateSearchTerm(value)).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(validateSearchTerm('  luke  ')).toBe('luke');
  });

  it('preserves whitespace inside the term', () => {
    expect(validateSearchTerm('  luke skywalker  ')).toBe('luke skywalker');
  });

  it('accepts a term at the maximum length', () => {
    const term = 'a'.repeat(MAX_SEARCH_TERM_LENGTH);

    expect(validateSearchTerm(term)).toBe(term);
  });

  it('rejects a term longer than the maximum', () => {
    // Rejecting rather than truncating, for the same reason `validateRelationLimit` refuses to
    // clamp: a silently shortened term returns rows that do not match what was asked for, and the
    // caller has no way to discover that happened.
    expect(() => validateSearchTerm('a'.repeat(MAX_SEARCH_TERM_LENGTH + 1))).toThrow(GraphQLError);
  });

  it('measures length after trimming', () => {
    const padded = `  ${'a'.repeat(MAX_SEARCH_TERM_LENGTH)}  `;

    expect(validateSearchTerm(padded)).toHaveLength(MAX_SEARCH_TERM_LENGTH);
  });

  it('passes wildcard characters through unchanged', () => {
    // Escaping belongs to the storage tier, which knows it is building a LIKE pattern. Escaping
    // here would double-escape once the infrastructure tier did its own job.
    expect(validateSearchTerm('100%')).toBe('100%');
    expect(validateSearchTerm('a_b')).toBe('a_b');
  });
});
