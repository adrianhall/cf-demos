import { parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { collectionQuery, detailQuery, globalSearchQuery } from '../../src/client/api/queries';
import { ENTITY_TYPES, ENTITY_TYPE_IDS } from '../../src/client/domain/entity-types';
import { schema } from '../../src/worker/application/graphql/schema';

describe('generated explorer GraphQL documents', () => {
  it.each(ENTITY_TYPE_IDS)(
    'validates the %s collection query against the real schema',
    (typeId) => {
      expect(
        validate(schema, parse(collectionQuery(ENTITY_TYPES[typeId]))).map((error) => error.message)
      ).toEqual([]);
    }
  );

  it.each(ENTITY_TYPE_IDS)('validates the %s detail query against the real schema', (typeId) => {
    expect(
      validate(schema, parse(detailQuery(ENTITY_TYPES[typeId]))).map((error) => error.message)
    ).toEqual([]);
  });

  it('keeps global search within the schema complexity budget', () => {
    // Validation includes Pothos's complexity rules. If someone adds relation fields to this query
    // in the future, this catches the point at which global search becomes too broad before a user
    // meets a generic GraphQL error in the search box.
    expect(validate(schema, parse(globalSearchQuery())).map((error) => error.message)).toEqual([]);
  });
});
