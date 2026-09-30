import { describe, expect, it } from 'vitest';
import { classifyAttributeValue, isMissing } from '../../src/ui/domain/attribute-value';
import { ENTITY_TYPES, ENTITY_TYPE_IDS } from '../../src/ui/domain/entity-types';

describe('attribute-value classification', () => {
  it('keeps numeric-looking text as text', () => {
    // The UI must never parse or decorate it: a neighbouring row can say "unknown" in exactly the
    // same field, so parsing only some rows would make the data look more precise than it is.
    expect(classifyAttributeValue('1,000,000').text).toBe('1,000,000');
  });

  it.each([
    ['unknown', 'Unknown', 'unknown'],
    ['N/A', 'Not applicable', 'notApplicable'],
    ['none', 'None', 'none']
  ])('normalises %s without losing what it means', (raw, text, kind) => {
    expect(classifyAttributeValue(raw)).toMatchObject({ text, kind });
  });

  it('de-emphasises unrecorded and not-applicable values, but not a factual none', () => {
    expect(isMissing(classifyAttributeValue('unknown'))).toBe(true);
    expect(isMissing(classifyAttributeValue('n/a'))).toBe(true);
    expect(isMissing(classifyAttributeValue('none'))).toBe(false);
  });

  it('treats indefinite as a real answer, not an absence', () => {
    expect(classifyAttributeValue('indefinite')).toEqual({ kind: 'value', text: 'indefinite' });
  });

  it('reports an absent field as unrecorded rather than rendering a blank cell', () => {
    expect(classifyAttributeValue(null)).toEqual({ kind: 'unknown', text: 'Unknown' });
    expect(classifyAttributeValue('   ')).toEqual({ kind: 'unknown', text: 'Unknown' });
  });
});

describe('entity type descriptors', () => {
  it('describes every navigation type exactly once', () => {
    expect(Object.keys(ENTITY_TYPES).sort()).toEqual([...ENTITY_TYPE_IDS].sort());
  });

  it('keeps the API’s actual asymmetric relation graph', () => {
    expect(ENTITY_TYPES.films.relations).toHaveLength(5);
    expect(ENTITY_TYPES.people.relations).toHaveLength(5);
    expect(ENTITY_TYPES.planets.relations.map((relation) => relation.field)).toEqual([
      'residents',
      'films'
    ]);
    expect(ENTITY_TYPES.starships.relations.map((relation) => relation.field)).toEqual([
      'pilots',
      'films'
    ]);
    expect(ENTITY_TYPES.vehicles.relations.map((relation) => relation.field)).toEqual([
      'pilots',
      'films'
    ]);
  });

  it('does not invent the missing Planet → Species reverse relation', () => {
    expect(ENTITY_TYPES.planets.relations.some((relation) => relation.target === 'species')).toBe(
      false
    );
  });

  it('marks exactly the nullable single-valued relations as single', () => {
    // 32 of 82 characters have no recorded species, so the single-valued case is met immediately
    // rather than as an edge case. The detail view presents these as one item, never a list of
    // one, and states their absence explicitly.
    const single = ENTITY_TYPE_IDS.flatMap((typeId) =>
      ENTITY_TYPES[typeId].relations
        .filter((relation) => relation.single === true)
        .map((relation) => `${typeId}.${relation.field}`)
    );

    expect(single.sort()).toEqual(['people.homeworld', 'people.species', 'species.homeworld']);
  });
});
