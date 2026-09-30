import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore, MISSING_RECORD_MESSAGE } from '../../src/ui/state/catalog-store';

const PLANET_ID = '33333333-3333-3333-3333-333333333333';

/**
 * Answer the next `fetch` with a successful GraphQL response.
 *
 * @param data Value to return as the operation's `data`.
 * @returns A response resolving to that body.
 */
function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('CatalogStore', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('caches a collection for the session rather than refetching it', async () => {
    // The dataset is immutable for the life of the page, which is what makes backward navigation
    // through the breadcrumb instant (UISPEC §15).
    fetchMock.mockResolvedValue(
      graphqlResponse({ items: [{ id: PLANET_ID, name: 'Tatooine', climate: 'arid' }] })
    );
    const store = new CatalogStore();

    await store.loadCollection('planets');
    await store.loadCollection('planets');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.collectionState('planets').value).toEqual([
      { id: PLANET_ID, title: 'Tatooine', subtitle: 'arid' }
    ]);
  });

  it('issues one request when several callers want the same collection at once', async () => {
    // Three columns can want the same collection in the same tick. Per-component state would
    // issue three requests; the shared in-flight map means the later callers await the first.
    fetchMock.mockResolvedValue(graphqlResponse({ items: [] }));
    const store = new CatalogStore();

    await Promise.all([
      store.loadCollection('films'),
      store.loadCollection('films'),
      store.loadCollection('films')
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('scopes a failure to the thing that failed instead of throwing', async () => {
    // A failed panel must leave the rest of the screen usable (UISPEC §9.4), which is only
    // possible if the failure is recorded as state rather than propagated to the caller.
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const store = new CatalogStore();

    await expect(store.loadCollection('films')).resolves.toBeUndefined();

    expect(store.collectionState('films')).toMatchObject({
      value: null,
      loading: false,
      error: 'Could not reach the server. Check your connection.'
    });
  });

  it('retries a previously failed collection', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    fetchMock.mockResolvedValueOnce(
      graphqlResponse({ items: [{ id: PLANET_ID, name: 'Tatooine', climate: 'arid' }] })
    );
    const store = new CatalogStore();

    await store.loadCollection('planets');
    await store.loadCollection('planets');

    expect(store.collectionState('planets').error).toBeNull();
    expect(store.collectionState('planets').value).toHaveLength(1);
  });

  it('reports a missing record as a fact rather than a retryable failure', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ entity: null }));
    const store = new CatalogStore();

    await store.loadEntity('planets', PLANET_ID);

    expect(store.entityState('planets', PLANET_ID).error).toBe(MISSING_RECORD_MESSAGE);
  });

  it('reports an expired session once, centrally', async () => {
    // Session expiry is not about the thing being loaded, so the banner — not the failing panel —
    // is where the user is offered a way back (UISPEC §9.4, §10).
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    const store = new CatalogStore();
    const onExpired = vi.fn();
    store.setSessionExpiredHandler(onExpired);

    await store.loadCollection('films');

    expect(onExpired).toHaveBeenCalledOnce();
    expect(store.collectionState('films').error).toBe('Your session has expired.');
  });

  it('groups global search results by type and omits empty groups', async () => {
    fetchMock.mockResolvedValue(
      graphqlResponse({
        films: [],
        people: [{ id: 'p1', name: 'Luke Skywalker', birthYear: '19BBY' }],
        planets: [{ id: PLANET_ID, name: 'Tatooine', climate: 'arid' }],
        species: [],
        starships: [],
        vehicles: []
      })
    );
    const store = new CatalogStore();

    const groups = await store.searchEverything('ta');

    expect(groups.map((group) => group.typeId)).toEqual(['people', 'planets']);
    expect(groups[1]?.matches).toEqual([{ id: PLANET_ID, title: 'Tatooine', subtitle: 'arid' }]);
  });

  it('notifies subscribers as state changes', async () => {
    fetchMock.mockResolvedValue(graphqlResponse({ items: [] }));
    const store = new CatalogStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.loadCollection('films');
    unsubscribe();
    await store.loadCollection('planets');

    // Once for the loading state and once for the result; nothing after unsubscribing.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns a stable idle snapshot for anything never requested', () => {
    // `useSyncExternalStore` compares snapshots by identity. A fresh idle object per read would
    // make React believe the store changed on every render and re-render without end.
    const store = new CatalogStore();

    expect(store.collectionState('films')).toBe(store.collectionState('planets'));
  });
});
