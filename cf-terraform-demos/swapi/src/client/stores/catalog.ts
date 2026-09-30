import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { executeGraphQL, GraphQLRequestError } from '../api/graphql-client';
import { collectionQuery, detailQuery, globalSearchQuery } from '../api/queries';
import {
  ENTITY_TYPES,
  ENTITY_TYPE_IDS,
  type EntityTypeDescriptor,
  type EntityTypeId
} from '../domain/entity-types';
import { useSessionStore } from './session';

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
 * Build the initial state for something not yet requested.
 *
 * @typeParam Value Type of the eventual value.
 * @returns An idle state.
 */
function idle<Value>(): AsyncState<Value> {
  return { value: null, loading: false, error: null };
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
 * Turn a field known to be a displayed scalar into text without accidentally stringifying an object
 * as `[object Object]`.
 *
 * Entity records also hold relation objects and arrays, so an unrestricted `String(value)` would
 * hide a descriptor bug by producing a plausible-looking but useless label. Treating only real
 * strings and numbers as displayable makes that mistake an empty row instead, which is visible in
 * review and test.
 *
 * @param value Field value from a GraphQL record.
 * @returns The scalar text, or an empty string when the field is absent or not scalar.
 */
function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/**
 * The dataset, loaded on demand and cached for the session.
 *
 * ## Why caching is safe here
 *
 * The data is read-only and fixed: there is no mutation in the schema, and no per-user variation to
 * invalidate against. An entity fetched once therefore never needs fetching again for the life of
 * the page, which is what makes navigating back through the breadcrumb feel instant (UISPEC §15).
 * This would be an unsafe assumption for almost any other dataset, and is called out here because
 * the planned editor will invalidate it — the day mutations land, this cache needs an eviction
 * story.
 *
 * Searches are not cached. They are cheap, the term changes on every keystroke, and caching them
 * would mean holding a result set per prefix for no benefit.
 *
 * @returns The catalog store.
 */
export const useCatalogStore = defineStore('catalog', () => {
  const session = useSessionStore();

  const collections = ref<Partial<Record<EntityTypeId, AsyncState<EntitySummary[]>>>>({});
  const entities = ref<Record<string, AsyncState<EntityRecord>>>({});

  /**
   * Convert a caught error into a message, reporting an expired session globally.
   *
   * Session expiry is deliberately handled here rather than per call site: it is the one failure
   * that is not about the thing being loaded, and the banner — not the panel — is where the user is
   * offered a way back (UISPEC §9.4, §10).
   *
   * @param cause Value thrown by the request.
   * @returns A message safe to display next to whatever failed.
   */
  function describeFailure(cause: unknown): string {
    if (cause instanceof GraphQLRequestError) {
      if (cause.kind === 'unauthenticated') {
        session.markExpired();
      }
      return cause.message;
    }

    return 'Something went wrong loading this.';
  }

  /**
   * Cache key for one entity, namespaced by type.
   *
   * Identifiers are UUIDs and so are unique across tables in practice, but keying on the pair
   * states the intent and keeps the cache correct even if that ever stopped being true.
   *
   * @param typeId Owning entity type.
   * @param id Entity identifier.
   * @returns The cache key.
   */
  function entityKey(typeId: EntityTypeId, id: string): string {
    return `${typeId}:${id}`;
  }

  /**
   * Load a collection's rows, or return the cached ones.
   *
   * Only ever loads the _unfiltered_ collection. Filtering a list of at most 82 rows the client
   * already holds is instant and needs no round trip, whereas a server call per keystroke would add
   * latency to a filter that UISPEC §5.2 requires to feel immediate. The server-side `search`
   * argument is what powers global search, where the client cannot hold every collection yet — see
   * {@link searchEverything}.
   *
   * @param typeId Collection to load.
   * @returns A promise fulfilled once the collection is cached or has failed.
   */
  async function loadCollection(typeId: EntityTypeId): Promise<void> {
    const existing = collections.value[typeId];
    if (existing?.value !== null && existing?.value !== undefined) {
      return;
    }
    if (existing?.loading === true) {
      return;
    }

    collections.value = { ...collections.value, [typeId]: { ...idle(), loading: true } };

    const descriptor = ENTITY_TYPES[typeId];
    try {
      const data = await executeGraphQL<{ items: EntityRecord[] }>(collectionQuery(descriptor));
      const rows = data.items.map((item) => toSummary(descriptor, item));
      collections.value = {
        ...collections.value,
        [typeId]: { value: rows, loading: false, error: null }
      };
    } catch (cause) {
      collections.value = {
        ...collections.value,
        [typeId]: { value: null, loading: false, error: describeFailure(cause) }
      };
    }
  }

  /**
   * Load one entity's full detail, or return the cached record.
   *
   * One request covers the attributes and every relation panel, which is the shape the API is built
   * for: relations resolve in a bounded number of statements however many are selected, so a single
   * operation per view costs far less than one per panel (UISPEC §15).
   *
   * @param typeId Type of the entity.
   * @param id Entity identifier.
   * @returns A promise fulfilled once the entity is cached or has failed.
   */
  async function loadEntity(typeId: EntityTypeId, id: string): Promise<void> {
    const key = entityKey(typeId, id);
    const existing = entities.value[key];
    if (existing?.value != null || existing?.loading) {
      return;
    }

    entities.value = { ...entities.value, [key]: { ...idle(), loading: true } };

    try {
      const data = await executeGraphQL<{ entity: EntityRecord | null }>(
        detailQuery(ENTITY_TYPES[typeId]),
        { id }
      );
      entities.value = {
        ...entities.value,
        [key]: {
          value: data.entity,
          loading: false,
          // A null entity is not a transport failure — the identifier simply matches nothing,
          // which is what a stale shared link looks like. Saying so is more useful than a retry
          // button that will never succeed.
          error: data.entity === null ? 'That record no longer exists.' : null
        }
      };
    } catch (cause) {
      entities.value = {
        ...entities.value,
        [key]: { value: null, loading: false, error: describeFailure(cause) }
      };
    }
  }

  /**
   * Search every collection at once.
   *
   * Server-backed rather than filtered from cache, because global search must work before the user
   * has visited any collection — on a cold load, the client holds nothing to filter. One operation
   * covers all six types (UISPEC §12.2).
   *
   * @param term Raw search text as typed.
   * @param signal Abort signal cancelling a superseded search.
   * @returns Matches grouped by type, in navigation order, with empty groups omitted.
   * @throws {GraphQLRequestError} When the request fails; the caller decides how to present it.
   * @throws {DOMException} When the search was superseded and aborted.
   */
  async function searchEverything(
    term: string,
    signal?: AbortSignal
  ): Promise<{ typeId: EntityTypeId; matches: EntitySummary[] }[]> {
    const data = await executeGraphQL<Record<EntityTypeId, EntityRecord[]>>(
      globalSearchQuery(),
      { search: term },
      signal
    );

    return ENTITY_TYPE_IDS.map((typeId) => ({
      typeId,
      matches: (data[typeId] ?? []).map((item) => toSummary(ENTITY_TYPES[typeId], item))
    })).filter((group) => group.matches.length > 0);
  }

  /**
   * Read a collection's current state without triggering a load.
   *
   * @returns A function from type identifier to its state, idle when never requested.
   */
  const collectionState = computed(
    () =>
      (typeId: EntityTypeId): AsyncState<EntitySummary[]> =>
        collections.value[typeId] ?? idle<EntitySummary[]>()
  );

  /**
   * Read an entity's current state without triggering a load.
   *
   * @returns A function from type and identifier to its state, idle when never requested.
   */
  const entityState = computed(
    () =>
      (typeId: EntityTypeId, id: string): AsyncState<EntityRecord> =>
        entities.value[entityKey(typeId, id)] ?? idle<EntityRecord>()
  );

  return {
    collections,
    entities,
    collectionState,
    entityState,
    loadCollection,
    loadEntity,
    searchEverything
  };
});
