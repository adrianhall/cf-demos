import { parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { collectionQuery, detailQuery, globalSearchQuery } from '../../src/ui/api/queries';
import { ENTITY_TYPES, ENTITY_TYPE_IDS } from '../../src/ui/domain/entity-types';
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

  it('requests only the fields a list row displays', () => {
    // UISPEC §15: fetching every scalar to render a two-line row wastes exactly the efficiency the
    // API provides. Building the document from the descriptors is what makes this hold, and this
    // asserts the property rather than the mechanism.
    const document = collectionQuery(ENTITY_TYPES.planets);

    expect(document).toContain('id name climate');
    expect(document).not.toContain('population');
  });
});
