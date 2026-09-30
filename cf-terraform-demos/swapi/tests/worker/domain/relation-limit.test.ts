import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  MAX_RELATION_LIMIT,
  validateRelationLimit
} from '../../../src/worker/domain/relation-limit';

describe('validateRelationLimit', () => {
  it('returns undefined when no limit is requested', () => {
    // Absent and null must both mean "no limit", because GraphQL delivers an omitted optional
    // argument as undefined but an explicitly null one as null. The repositories rely on this to
    // decide whether to emit the limiting clause at all.
    expect(validateRelationLimit(undefined)).toBeUndefined();
    expect(validateRelationLimit(null)).toBeUndefined();
  });

  it('accepts the inclusive bounds of the supported range', () => {
    expect(validateRelationLimit(1)).toBe(1);
    expect(validateRelationLimit(MAX_RELATION_LIMIT)).toBe(MAX_RELATION_LIMIT);
  });

  it('accepts a value inside the range unchanged', () => {
    expect(validateRelationLimit(25)).toBe(25);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['just above the maximum', MAX_RELATION_LIMIT + 1],
    ['far above the maximum', 2_000_000_000]
  ])('rejects a limit that is %s', (_label, value) => {
    // Rejecting rather than clamping is the documented contract: a caller who asked for 5000 rows
    // and silently received 100 would have no way to discover the limit.
    expect(() => validateRelationLimit(value)).toThrow(GraphQLError);
  });

  it('rejects a non-integer limit', () => {
    // GraphQL's Int type does not guarantee this on its own once a value has been coerced, and a
    // fractional value would reach SQL as a meaningless row-number comparison.
    expect(() => validateRelationLimit(2.5)).toThrow(GraphQLError);
  });

  it('names the supported range in the error, so a caller can correct the request', () => {
    expect(() => validateRelationLimit(0)).toThrow(`between 1 and ${MAX_RELATION_LIMIT}`);
  });
});
