/**
 * @file The session-lifetime cache of the dataset, and the single place the explorer talks to the
 *   catalog. This is a plain observable store rather than a React context or a state-management
 *   dependency, and that is deliberate on two counts. First, **it is not React**. The caching rule
 *   it implements — an entity fetched once is never refetched — is a fact about the data, not about
 *   the view, so it is expressed in ordinary TypeScript and unit-tested without rendering anything.
 *   `./use-catalog.ts` is the thin React binding on top, and it is the only file that knows
 *   `useSyncExternalStore` exists. Second, **deduplication has to be global to be correct**. Three
 *   components can want the same collection in the same tick; per-component state would issue three
 *   requests. Holding the in-flight promise in one shared map means the second and third callers
 *   await the first.
 *
 *   ## Why caching is safe here
 *
 *   The data is read-only and fixed: there is no mutation in the schema, and no per-user variation
 *   to invalidate against. An entity fetched once therefore never needs fetching again for the life
 *   of the page, which is what makes navigating back through the breadcrumb feel instant (UISPEC
 *   §15). This would be an unsafe assumption for almost any other dataset, and is called out here
 *   because the planned editor will invalidate it — the day mutations land, this cache needs an
 *   eviction story. Searches are deliberately **not** cached. They are cheap, the term changes on
 *   every keystroke, and caching them would mean holding a result set per prefix for no benefit.
 */

import { executeGraphQL, GraphQLRequestError } from '../api/graphql-client';
import { collectionQuery, detailQuery, globalSearchQuery } from '../api/queries';
import {
  ENTITY_TYPES,
  ENTITY_TYPE_IDS,
  type EntityTypeDescriptor,
  type EntityTypeId
} from '../domain/entity-types';
import { scalarText } from '../domain/scalar-text';

/**
 * An entity as the API returned it.
 *
 * Deliberately an index signature rather than six generated interfaces. The components that read
 * these records are driven by the type descriptors — they look up `entity[attribute.field]` — so a
 * precise per-type interface would be narrowed away at exactly the point of use and would buy
 * nothing but six more declarations to maintain alongside the descriptors. `id` is pulled out
 * because every code path relies on it.
 */
export interface EntityRecord {
  /**
   * Stable identifier, present on every entity and used for navigation and caching.
   */
  id: string;
  /**
   * Remaining fields: scalars as strings, relations as nested records or arrays of them.
   */
  [field: string]: unknown;
}

/**
 * A summary row as shown in a list or a relation panel.
 */
export interface EntitySummary {
  /**
   * Entity identifier.
   */
  id: string;
  /**
   * Primary label.
   */
  title: string;
  /**
   * One line of supporting context, so a row can be recognised without navigating to it.
   */
  subtitle: string;
}

/**
 * Loading and error state for one asynchronously loaded thing.
 *
 * Every remote read in the explorer is tracked with one of these, per collection and per entity, so
 * a failure is scoped to the surface that failed. UISPEC §9.4 requires a broken relation panel to
 * leave the rest of the screen usable, which is impossible with a single global error flag.
 *
 * @typeParam Value Type of the loaded value.
 */
export interface AsyncState<Value> {
  /**
   * The value, once loaded.
   */
  value: Value | null;
  /**
   * Whether a request is in flight.
   */
  loading: boolean;
  /**
   * User-facing failure message, or `null`.
   */
  error: string | null;
}

/**
 * The idle state every unrequested thing reports.
 *
 * A single frozen instance rather than a factory, because `useSyncExternalStore` compares snapshots
 * by identity: returning a fresh `{ value: null, loading: false, error: null }` on every read would
 * make React believe the store had changed on every render and re-render without end.
 */
const IDLE: AsyncState<never> = Object.freeze({ value: null, loading: false, error: null });

/**
 * Read the shared idle state at a specific value type.
 *
 * @typeParam Value Type the caller expects once something is loaded.
 * @returns The frozen idle state, typed for the caller.
 */
export function idleState<Value>(): AsyncState<Value> {
  return IDLE;
}

/**
 * Reduce a full entity record to the summary a list row needs.
 *
 * @param descriptor Type describing which fields carry the label and context.
 * @param entity Record to summarise.
 * @returns The summary. Missing fields become empty strings rather than `undefined`, so a row
 *   renders as incomplete rather than as `undefined`.
 */
export function toSummary(descriptor: EntityTypeDescriptor, entity: EntityRecord): EntitySummary {
  return {
    id: entity.id,
    title: scalarText(entity[descriptor.displayField]),
    subtitle: scalarText(entity[descriptor.subtitleField])
  };
}

/**
 * One group of global-search matches, as the results popover renders them.
 */
export interface SearchGroup {
  /**
   * Type the matches belong to.
   */
  typeId: EntityTypeId;
  /**
   * Matching rows, in the API's order.
   */
  matches: EntitySummary[];
}

/**
 * Notified whenever any cached state changes.
 */
type Listener = () => void;

/**
 * The dataset, loaded on demand and cached for the session.
 *
 * Every mutation replaces the map it touches rather than editing it in place. That is not ceremony:
 * `useSyncExternalStore` decides whether to re-render by comparing the previous snapshot with the
 * new one by identity, so an in-place edit would be invisible to React and the UI would silently
 * fail to update.
 */
export class CatalogStore {
  /**
   * Cached collection rows, keyed by type identifier.
   */
  private collections: Readonly<Partial<Record<EntityTypeId, AsyncState<EntitySummary[]>>>> = {};

  /**
   * Cached entity records, keyed by `type:id`.
   */
  private entities: Readonly<Record<string, AsyncState<EntityRecord>>> = {};

  /**
   * Loads currently in flight, keyed the same way as their eventual cache entry.
   *
   * Held separately from the cached state so that a second caller arriving mid-flight awaits the
   * first request rather than starting another. The `loading` flag alone could express that, but
   * only by making every caller poll it; the promise lets them await.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Subscribers notified after every state change.
   */
  private readonly listeners = new Set<Listener>();

  /**
   * Reported to whoever owns the session banner when a request meets an expired Access session.
   */
  private onSessionExpired: (() => void) | undefined;

  /**
   * Subscribe to state changes.
   *
   * @param listener Called after each change; it should re-read the snapshots it cares about.
   * @returns A function that removes the subscription.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Register the callback invoked when any request discovers an expired Access session.
   *
   * Session expiry is reported once, centrally, rather than by each surface that meets a `401`,
   * because the banner — not the failing panel — is where the user is offered a way back (UISPEC
   * §9.4, §10).
   *
   * @param callback Invoked with no arguments when a `401`/`403` is seen. Replaces any previous
   *   callback.
   */
  setSessionExpiredHandler(callback: () => void): void {
    this.onSessionExpired = callback;
  }

  /**
   * Read a collection's current state without triggering a load.
   *
   * @param typeId Collection to read.
   * @returns Its cached state, or the shared idle state when it has never been requested.
   */
  collectionState(typeId: EntityTypeId): AsyncState<EntitySummary[]> {
    return this.collections[typeId] ?? idleState<EntitySummary[]>();
  }

  /**
   * Read an entity's current state without triggering a load.
   *
   * @param typeId Type of the entity.
   * @param id Entity identifier.
   * @returns Its cached state, or the shared idle state when it has never been requested.
   */
  entityState(typeId: EntityTypeId, id: string): AsyncState<EntityRecord> {
    return this.entities[entityKey(typeId, id)] ?? idleState<EntityRecord>();
  }

  /**
   * Load a collection's rows, or return immediately when they are already cached.
   *
   * Only ever loads the _unfiltered_ collection. Filtering a list of at most 82 rows the client
   * already holds is instant and needs no round trip, whereas a server call per keystroke would add
   * latency to a filter UISPEC §5.2 requires to feel immediate. The server-side `search` argument
   * is what powers global search, where the client cannot hold every collection yet — see
   * {@link searchEverything}.
   *
   * @param typeId Collection to load.
   * @returns A promise fulfilled once the collection is cached or its failure is recorded. It never
   *   rejects: the failure is stored as the collection's `error` so the column can render it
   *   without the caller needing a `catch`.
   */
  async loadCollection(typeId: EntityTypeId): Promise<void> {
    const cached = this.collections[typeId];
    if (cached?.value != null) {
      return;
    }

    const pending = this.inFlight.get(typeId);
    if (pending !== undefined) {
      return pending;
    }

    const request = this.fetchCollection(typeId).finally(() => this.inFlight.delete(typeId));
    this.inFlight.set(typeId, request);
    return request;
  }

  /**
   * Load one entity's full detail, or return immediately when it is already cached.
   *
   * One request covers the attributes and every relation panel, which is the shape the API is built
   * for: relations resolve in a bounded number of statements however many are selected, so a single
   * operation per view costs far less than one per panel (UISPEC §15).
   *
   * @param typeId Type of the entity.
   * @param id Entity identifier.
   * @returns A promise fulfilled once the entity is cached or its failure is recorded. It never
   *   rejects, for the same reason {@link loadCollection} does not.
   */
  async loadEntity(typeId: EntityTypeId, id: string): Promise<void> {
    const key = entityKey(typeId, id);
    const cached = this.entities[key];
    if (cached?.value != null) {
      return;
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const request = this.fetchEntity(typeId, id, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /**
   * Search every collection at once.
   *
   * Server-backed rather than filtered from cache, because global search must work before the user
   * has visited any collection — on a cold load, the client holds nothing to filter. One operation
   * covers all six types (UISPEC §12.2).
   *
   * Unlike the two load methods this one rejects rather than recording an error, because its result
   * is transient: the popover that requested it decides how to present a failure, and there is no
   * cache entry for a message to live in.
   *
   * @param term Raw search text as typed.
   * @param signal Abort signal cancelling a superseded search.
   * @returns Matches grouped by type, in navigation order, with empty groups omitted.
   * @throws {GraphQLRequestError} When the request fails. An `unauthenticated` failure also
   *   notifies the session handler before rejecting, so the banner reacts even though the caller
   *   renders its own message.
   * @throws {DOMException} When the search was superseded and aborted.
   */
  async searchEverything(term: string, signal?: AbortSignal): Promise<SearchGroup[]> {
    try {
      const data = await executeGraphQL<Record<EntityTypeId, EntityRecord[]>>(
        globalSearchQuery(),
        { search: term },
        signal
      );

      return ENTITY_TYPE_IDS.map((typeId) => ({
        typeId,
        matches: (data[typeId] ?? []).map((item) => toSummary(ENTITY_TYPES[typeId], item))
      })).filter((group) => group.matches.length > 0);
    } catch (cause) {
      if (cause instanceof GraphQLRequestError && cause.kind === 'unauthenticated') {
        this.onSessionExpired?.();
      }
      throw cause;
    }
  }

  /**
   * Fetch one collection and record the outcome.
   *
   * @param typeId Collection to fetch.
   * @returns A promise fulfilled once the result or the failure has been stored.
   */
  private async fetchCollection(typeId: EntityTypeId): Promise<void> {
    this.setCollection(typeId, { value: null, loading: true, error: null });

    const descriptor = ENTITY_TYPES[typeId];
    try {
      const data = await executeGraphQL<{ items: EntityRecord[] }>(collectionQuery(descriptor));
      this.setCollection(typeId, {
        value: data.items.map((item) => toSummary(descriptor, item)),
        loading: false,
        error: null
      });
    } catch (cause) {
      this.setCollection(typeId, {
        value: null,
        loading: false,
        error: this.describeFailure(cause)
      });
    }
  }

  /**
   * Fetch one entity and record the outcome.
   *
   * @param typeId Type of the entity.
   * @param id Entity identifier.
   * @param key Cache key the result is stored under.
   * @returns A promise fulfilled once the record or the failure has been stored.
   */
  private async fetchEntity(typeId: EntityTypeId, id: string, key: string): Promise<void> {
    this.setEntity(key, { value: null, loading: true, error: null });

    try {
      const data = await executeGraphQL<{ entity: EntityRecord | null }>(
        detailQuery(ENTITY_TYPES[typeId]),
        { id }
      );
      this.setEntity(key, {
        value: data.entity,
        loading: false,
        // A null entity is not a transport failure — the identifier simply matches nothing, which
        // is what a stale shared link looks like. Saying so is more useful than a retry button
        // that will never succeed.
        error: data.entity === null ? MISSING_RECORD_MESSAGE : null
      });
    } catch (cause) {
      this.setEntity(key, { value: null, loading: false, error: this.describeFailure(cause) });
    }
  }

  /**
   * Store one collection's state and notify subscribers.
   *
   * @param typeId Collection the state belongs to.
   * @param state New state.
   */
  private setCollection(typeId: EntityTypeId, state: AsyncState<EntitySummary[]>): void {
    this.collections = { ...this.collections, [typeId]: state };
    this.emit();
  }

  /**
   * Store one entity's state and notify subscribers.
   *
   * @param key Cache key.
   * @param state New state.
   */
  private setEntity(key: string, state: AsyncState<EntityRecord>): void {
    this.entities = { ...this.entities, [key]: state };
    this.emit();
  }

  /**
   * Notify every subscriber that something changed.
   */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Convert a caught error into a message, reporting an expired session centrally.
   *
   * @param cause Value thrown by the request.
   * @returns A message safe to display next to whatever failed.
   */
  private describeFailure(cause: unknown): string {
    if (cause instanceof GraphQLRequestError) {
      if (cause.kind === 'unauthenticated') {
        this.onSessionExpired?.();
      }
      return cause.message;
    }

    return 'Something went wrong loading this.';
  }
}

/**
 * Message stored for an identifier that matches no row.
 *
 * Exported so the detail view can tell this case apart from a transport failure and omit the retry
 * button, which could never succeed (UISPEC §9.4).
 */
export const MISSING_RECORD_MESSAGE = 'That record no longer exists.';

/**
 * Cache key for one entity, namespaced by type.
 *
 * Identifiers are UUIDs and so are unique across tables in practice, but keying on the pair states
 * the intent and keeps the cache correct even if that ever stopped being true. It also cannot
 * collide with a collection key, which is a bare type identifier and contains no colon.
 *
 * @param typeId Owning entity type.
 * @param id Entity identifier.
 * @returns The cache key.
 */
function entityKey(typeId: EntityTypeId, id: string): string {
  return `${typeId}:${id}`;
}
