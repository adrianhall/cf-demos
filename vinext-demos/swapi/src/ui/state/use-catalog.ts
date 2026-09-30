'use client';

/**
 * @file The React binding for {@link CatalogStore}. This is the only module that knows the store is
 *   consumed by React at all, which is what lets the cache itself (`./catalog-store.ts`) stay plain
 *   TypeScript and be tested without rendering. `useSyncExternalStore` rather than a context
 *   holding `useState`: the store is mutated from asynchronous callbacks outside React's control,
 *   and this is the hook React provides for exactly that. It also gets tearing right, which matters
 *   here because three columns read the same store during one render pass. The store arrives
 *   through context rather than as a module-level singleton. A singleton would work in the browser
 *   — this module is `'use client'`, so there is one instance per page — but it would make the
 *   session cache a piece of global state that nothing owns, and a test could not start from an
 *   empty one. Injecting it keeps the composition visible in `../components/explorer-app.tsx`,
 *   which is where the rest of the UI tier is composed too.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import type { EntityTypeId } from '../domain/entity-types';
import {
  CatalogStore,
  idleState,
  type AsyncState,
  type EntityRecord,
  type EntitySummary
} from './catalog-store';

/**
 * Carries the session's catalog store to every component that reads it.
 */
const CatalogContext = createContext<CatalogStore | null>(null);

/**
 * Props for {@link CatalogProvider}.
 */
export interface CatalogProviderProps {
  /**
   * Store to supply. Optional: omit it to create one scoped to this provider, which is the usual
   * case for the application and gives each test a clean cache.
   */
  store?: CatalogStore;
  /**
   * Subtree that may read the catalog.
   */
  children: ReactNode;
}

/**
 * Supply a catalog store to a subtree.
 *
 * The lazy `useState` initialiser is what makes an omitted `store` usable: `store ?? new
 * CatalogStore()` would construct a fresh, empty store on **every render**, discarding the session
 * cache each time anything above re-rendered and re-issuing every request. `useState` runs its
 * initialiser once per mount, so the store lives as long as the provider does.
 *
 * @param props The store to supply, or none to create one, and the subtree.
 * @returns The provider element.
 */
export function CatalogProvider({ store, children }: CatalogProviderProps): React.JSX.Element {
  const [created] = useState(() => new CatalogStore());
  return createElement(CatalogContext.Provider, { value: store ?? created }, children);
}

/**
 * Access the session's catalog store.
 *
 * @returns The store supplied by the nearest {@link CatalogProvider}.
 * @throws {Error} When no provider is above the caller. Failing loudly beats falling back to a
 *   fresh store, which would silently give that component a private, permanently empty cache and
 *   look like a data-loading bug rather than a composition mistake.
 */
export function useCatalogStore(): CatalogStore {
  const store = useContext(CatalogContext);
  if (store === null) {
    throw new Error('useCatalogStore must be used inside a CatalogProvider.');
  }
  return store;
}

/**
 * Subscribe to one collection's state, loading it on first use.
 *
 * @param typeId Collection to read, or `null` at the welcome state — in which case nothing is
 *   loaded and the idle state is returned, so a caller needs no conditional hook.
 * @returns That collection's current state, re-rendering the caller as it changes.
 */
export function useCollection(typeId: EntityTypeId | null): AsyncState<EntitySummary[]> {
  const catalog = useCatalogStore();

  useEffect(() => {
    if (typeId !== null) {
      void catalog.loadCollection(typeId);
    }
  }, [catalog, typeId]);

  const snapshot = useCallback(
    () => (typeId === null ? idleState<EntitySummary[]>() : catalog.collectionState(typeId)),
    [catalog, typeId]
  );

  return useSyncExternalStore(catalog.subscribe, snapshot, snapshot);
}

/**
 * Subscribe to one entity's state, loading it on first use.
 *
 * @param typeId Type of the entity, or `null` when nothing is selected.
 * @param entityId Entity identifier, or `null` when only a collection is selected.
 * @returns That entity's current state, re-rendering the caller as it changes. The idle state when
 *   either argument is `null`.
 */
export function useEntity(
  typeId: EntityTypeId | null,
  entityId: string | null
): AsyncState<EntityRecord> {
  const catalog = useCatalogStore();

  useEffect(() => {
    if (typeId !== null && entityId !== null) {
      void catalog.loadEntity(typeId, entityId);
    }
  }, [catalog, typeId, entityId]);

  const snapshot = useCallback(
    () =>
      typeId === null || entityId === null
        ? idleState<EntityRecord>()
        : catalog.entityState(typeId, entityId),
    [catalog, typeId, entityId]
  );

  return useSyncExternalStore(catalog.subscribe, snapshot, snapshot);
}

/**
 * Re-request something whose load previously failed.
 *
 * Retry needs its own entry point because {@link CatalogStore.loadCollection} and
 * {@link CatalogStore.loadEntity} are idempotent by design — they return early for anything already
 * cached, and a failed load leaves an error rather than a value, so calling them again genuinely
 * does refetch. This wrapper exists to name that intent at the call site and to keep the `void` of
 * a deliberately un-awaited promise out of the components.
 *
 * @param typeId Type to retry, or `null` to do nothing.
 * @param entityId Entity to retry, or `null` to retry the collection instead.
 * @returns A stable callback that starts the retry.
 */
export function useRetry(typeId: EntityTypeId | null, entityId: string | null): () => void {
  const catalog = useCatalogStore();

  return useCallback(() => {
    if (typeId === null) {
      return;
    }
    if (entityId === null) {
      void catalog.loadCollection(typeId);
      return;
    }
    void catalog.loadEntity(typeId, entityId);
  }, [catalog, typeId, entityId]);
}
