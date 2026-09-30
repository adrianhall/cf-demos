import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useExplorerStore } from '../../src/client/stores/explorer';

const FILM_ID = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '22222222-2222-2222-2222-222222222222';
const PLANET_ID = '33333333-3333-3333-3333-333333333333';

describe('explorer navigation', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts a new path and clears only that collection’s filter', () => {
    const store = useExplorerStore();
    store.setFilter('people', 'walker');
    store.setFilter('films', 'hope');

    store.selectCollection('people', 'People');

    expect(store.trail).toEqual([{ typeId: 'people', entityId: null, label: 'People' }]);
    expect(store.filterFor('people')).toBe('');
    expect(store.filterFor('films')).toBe('hope');
  });

  it('extends the actual path when selecting a related entity', () => {
    const store = useExplorerStore();
    store.selectCollection('films', 'Films');
    store.selectEntity('films', FILM_ID, 'A New Hope');
    store.selectEntity('people', PERSON_ID, 'Luke Skywalker');
    store.selectEntity('planets', PLANET_ID, 'Tatooine');

    expect(store.trail.map((step) => step.label)).toEqual([
      'Films',
      'A New Hope',
      'Luke Skywalker',
      'Tatooine'
    ]);
  });

  it('truncates rather than duplicating an entity already in the path', () => {
    const store = useExplorerStore();
    store.selectCollection('films', 'Films');
    store.selectEntity('films', FILM_ID, 'A New Hope');
    store.selectEntity('people', PERSON_ID, 'Luke Skywalker');
    store.selectEntity('films', FILM_ID, 'A New Hope');

    expect(store.trail.map((step) => step.label)).toEqual(['Films', 'A New Hope']);
  });

  it('keeps a same-type filter while selecting a different entity', () => {
    const store = useExplorerStore();
    store.selectCollection('people', 'People');
    store.setFilter('people', 'walker');
    store.selectEntity('people', PERSON_ID, 'Luke Skywalker');

    expect(store.filterFor('people')).toBe('walker');
  });

  it('preserves trail identity when an authoritative label is already present', () => {
    const store = useExplorerStore();
    store.selectCollection('films', 'Films');
    store.selectEntity('films', FILM_ID, 'The Phantom Menace');
    const before = store.trail;

    store.labelStep('films', FILM_ID, 'The Phantom Menace');

    // The label-hydration watcher observes this array. Replacing it for a semantic no-op creates a
    // self-sustaining promise loop that starves clicks and leaves the detail progress line frozen.
    expect(store.trail).toBe(before);
  });

  it('replaces a placeholder label exactly once', () => {
    const store = useExplorerStore();
    store.restoreTrail([{ typeId: 'films', entityId: FILM_ID, label: 'Loading…' }]);
    const before = store.trail;

    store.labelStep('films', FILM_ID, 'The Phantom Menace');

    expect(store.trail).not.toBe(before);
    expect(store.trail[0]?.label).toBe('The Phantom Menace');
  });
});
