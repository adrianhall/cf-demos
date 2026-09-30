import { describe, expect, it } from 'vitest';
import { decodeTrail, encodeTrail, routeState } from '../../src/client/router';
import type { TrailStep } from '../../src/client/stores/explorer';

const FILM_ID = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '22222222-2222-2222-2222-222222222222';

const trail: TrailStep[] = [
  { typeId: 'films', entityId: null, label: 'Films' },
  { typeId: 'films', entityId: FILM_ID, label: 'A New Hope' },
  { typeId: 'people', entityId: PERSON_ID, label: 'Luke Skywalker' }
];

describe('explorer URL trail', () => {
  it('encodes the full path once an entity has been selected', () => {
    expect(encodeTrail(trail)).toBe(`films~films:${FILM_ID}~people:${PERSON_ID}`);
  });

  it('keeps a collection-only URL clean', () => {
    expect(encodeTrail([trail[0]!])).toBeUndefined();
  });

  it('decodes collection and entity steps in order', () => {
    expect(decodeTrail(`films~films:${FILM_ID}~people:${PERSON_ID}`)).toEqual([
      { typeId: 'films', entityId: null, label: 'Films' },
      { typeId: 'films', entityId: FILM_ID, label: 'Loading…' },
      { typeId: 'people', entityId: PERSON_ID, label: 'Loading…' }
    ]);
  });

  it('keeps valid path segments when a shared URL contains malformed ones', () => {
    expect(decodeTrail(`films~nonsense~people:${PERSON_ID}~:broken`)).toEqual([
      { typeId: 'films', entityId: null, label: 'Films' },
      { typeId: 'people', entityId: PERSON_ID, label: 'Loading…' }
    ]);
  });

  it('does not duplicate the path entity in the restored history', () => {
    const state = routeState({
      params: { type: 'people', id: PERSON_ID },
      query: { trail: `films~films:${FILM_ID}~people:${PERSON_ID}` }
    } as never);

    expect(state).toEqual({
      typeId: 'people',
      entityId: PERSON_ID,
      trail: [
        { typeId: 'films', entityId: null, label: 'Films' },
        { typeId: 'films', entityId: FILM_ID, label: 'Loading…' }
      ]
    });
  });
});
