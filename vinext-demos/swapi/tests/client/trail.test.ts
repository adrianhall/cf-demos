import { describe, expect, it } from 'vitest';
import {
  collectionTrail,
  labelStep,
  selectEntity,
  truncateTrail,
  visibleTrail,
  type TrailStep
} from '../../src/ui/state/trail';
import { decodeTrail, encodeTrail, explorerHref, readLocation } from '../../src/ui/state/trail-url';

const FILM_ID = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '22222222-2222-2222-2222-222222222222';
const PLANET_ID = '33333333-3333-3333-3333-333333333333';

const trail: TrailStep[] = [
  { typeId: 'films', entityId: null, label: 'Films' },
  { typeId: 'films', entityId: FILM_ID, label: 'A New Hope' },
  { typeId: 'people', entityId: PERSON_ID, label: 'Luke Skywalker' }
];

describe('trail navigation', () => {
  it('starts a new path at a collection', () => {
    expect(collectionTrail('people', 'People')).toEqual([
      { typeId: 'people', entityId: null, label: 'People' }
    ]);
  });

  it('extends the actual path when selecting a related entity', () => {
    let current: readonly TrailStep[] = collectionTrail('films', 'Films');
    current = selectEntity(current, 'films', FILM_ID, 'A New Hope', 'Films');
    current = selectEntity(current, 'people', PERSON_ID, 'Luke Skywalker', 'People');
    current = selectEntity(current, 'planets', PLANET_ID, 'Tatooine', 'Planets');

    expect(current.map((step) => step.label)).toEqual([
      'Films',
      'A New Hope',
      'Luke Skywalker',
      'Tatooine'
    ]);
  });

  it('truncates rather than duplicating an entity already in the path', () => {
    let current: readonly TrailStep[] = collectionTrail('films', 'Films');
    current = selectEntity(current, 'films', FILM_ID, 'A New Hope', 'Films');
    current = selectEntity(current, 'people', PERSON_ID, 'Luke Skywalker', 'People');
    current = selectEntity(current, 'films', FILM_ID, 'A New Hope', 'Films');

    expect(current.map((step) => step.label)).toEqual(['Films', 'A New Hope']);
  });

  it('seeds the originating collection when there is no path yet', () => {
    // Reached by opening a relation target from a deep link whose trail was lost. The breadcrumb
    // must still begin somewhere the user can click back to.
    expect(selectEntity([], 'planets', PLANET_ID, 'Tatooine', 'Planets')).toEqual([
      { typeId: 'planets', entityId: null, label: 'Planets' },
      { typeId: 'planets', entityId: PLANET_ID, label: 'Tatooine' }
    ]);
  });

  it('returns to an earlier step and discards what followed', () => {
    expect(truncateTrail(trail, 1).map((step) => step.label)).toEqual(['Films', 'A New Hope']);
  });

  it('ignores a stale click on a breadcrumb that has since been truncated', () => {
    expect(truncateTrail(trail, 9)).toBe(trail);
  });
});

describe('trail label hydration', () => {
  it('preserves array identity when the authoritative label is already present', () => {
    // The hydration effect depends on this array. Replacing it for a semantic no-op creates a
    // self-sustaining update loop that starves interaction without producing an error.
    expect(labelStep(trail, 'films', FILM_ID, 'A New Hope')).toBe(trail);
  });

  it('replaces a placeholder label exactly once', () => {
    const restored: TrailStep[] = [{ typeId: 'films', entityId: FILM_ID, label: 'Loading…' }];

    const updated = labelStep(restored, 'films', FILM_ID, 'The Phantom Menace');

    expect(updated).not.toBe(restored);
    expect(updated[0]?.label).toBe('The Phantom Menace');
  });

  it('ignores a label for a step no longer in the trail', () => {
    expect(labelStep(trail, 'planets', PLANET_ID, 'Tatooine')).toBe(trail);
  });
});

describe('breadcrumb truncation', () => {
  it('shows a short trail in full', () => {
    expect(visibleTrail(trail).map((segment) => segment.kind)).toEqual(['step', 'step', 'step']);
  });

  it('elides the middle of a long trail, keeping the origin and the recent steps', () => {
    const long: TrailStep[] = Array.from({ length: 8 }, (_, index) => ({
      typeId: 'films',
      entityId: `id-${index}`,
      label: `Step ${index}`
    }));

    const segments = visibleTrail(long, 5);

    expect(segments.map((segment) => segment.kind)).toEqual([
      'step',
      'ellipsis',
      'step',
      'step',
      'step'
    ]);
    expect(segments.at(0)).toMatchObject({ index: 0 });
    expect(segments.at(-1)).toMatchObject({ index: 7 });
  });

  it('says how many steps the gap stands for', () => {
    const long: TrailStep[] = Array.from({ length: 8 }, (_, index) => ({
      typeId: 'films',
      entityId: `id-${index}`,
      label: `Step ${index}`
    }));

    const ellipsis = visibleTrail(long, 5).find((segment) => segment.kind === 'ellipsis');

    // Eight steps, of which the origin and the last three are shown: four are hidden.
    expect(ellipsis).toEqual({ kind: 'ellipsis', hidden: 4 });
  });
});

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
    expect(readLocation('people', PERSON_ID, `films~films:${FILM_ID}~people:${PERSON_ID}`)).toEqual(
      {
        typeId: 'people',
        entityId: PERSON_ID,
        trail: [
          { typeId: 'films', entityId: null, label: 'Films' },
          { typeId: 'films', entityId: FILM_ID, label: 'Loading…' }
        ]
      }
    );
  });

  it('treats an unknown type in the URL as the welcome state', () => {
    expect(readLocation('droids', undefined, null)).toEqual({
      typeId: null,
      entityId: null,
      trail: []
    });
  });

  it('passes an unrecognised identifier through so the API can answer for it', () => {
    // The client invents no UUID validation rule: a stale shared link should render "that record
    // no longer exists" rather than a client-side rejection.
    expect(readLocation('planets', 'not-a-uuid', null)).toMatchObject({
      typeId: 'planets',
      entityId: 'not-a-uuid'
    });
  });

  it('builds a shareable href carrying the path taken', () => {
    expect(explorerHref('people', PERSON_ID, trail)).toBe(
      `/people/${PERSON_ID}?trail=${encodeURIComponent(`films~films:${FILM_ID}~people:${PERSON_ID}`)}`
    );
  });

  it('builds a bare collection href when there is no path to preserve', () => {
    expect(explorerHref('planets', null, collectionTrail('planets', 'Planets'))).toBe('/planets');
  });
});
