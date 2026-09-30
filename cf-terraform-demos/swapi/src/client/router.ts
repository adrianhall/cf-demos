import { createRouter, createWebHistory, type RouteLocationNormalizedLoaded } from 'vue-router';
import { ENTITY_TYPES, findEntityType, type EntityTypeId } from './domain/entity-types';
import type { TrailStep } from './stores/explorer';
import ExplorerView from './views/ExplorerView.vue';

/**
 * Delimiter separating steps in the URL's encoded traversal path.
 *
 * Entity identifiers are UUIDs, which never contain `~`, so a compact path is unambiguous without
 * introducing JSON into an address bar. A collection step is its type (`films`); an entity step is
 * `type:id`. It is a query parameter rather than a pathname segment because the current entity's
 * canonical, shareable location stays readable: `/people/<id>?trail=films~films:<id>~people:<id>`.
 */
const TRAIL_SEPARATOR = '~';

/**
 * Encode an exploration trail for the address bar.
 *
 * A collection-only trail has no entity path to preserve and is omitted, keeping fresh collection
 * URLs clean (`/people`, not `/people?trail=people`). Once the user opens an entity, every step —
 * including its originating collection — is encoded so that a reload can reconstruct the honest
 * breadcrumb (`Films › A New Hope › Luke Skywalker` rather than just the terminal record).
 *
 * @param steps Navigation steps in order.
 * @returns A compact, URL-safe path, or `undefined` when there is no entity path to preserve.
 */
export function encodeTrail(steps: readonly TrailStep[]): string | undefined {
  if (!steps.some((step) => step.entityId !== null)) {
    return undefined;
  }

  return steps
    .map((step) => (step.entityId === null ? step.typeId : `${step.typeId}:${step.entityId}`))
    .join(TRAIL_SEPARATOR);
}

/**
 * Decode a traversal path from a URL.
 *
 * Invalid segments are ignored rather than making a shared URL unusable. A URL is user-editable and
 * may have been copied through a system that truncated a query string; preserving the valid steps
 * is friendlier than rejecting the entire location because one tail segment is malformed. Labels
 * are placeholders until their records load, at which point the explorer store replaces them with
 * real display names.
 *
 * @param encoded `trail` query parameter value.
 * @returns Valid entity steps in order.
 */
export function decodeTrail(encoded: string | null | undefined): TrailStep[] {
  if (encoded === null || encoded === undefined || encoded.length === 0) {
    return [];
  }

  return encoded.split(TRAIL_SEPARATOR).flatMap((segment): TrailStep[] => {
    const separator = segment.indexOf(':');
    if (separator === -1) {
      const descriptor = findEntityType(segment);
      return descriptor === undefined
        ? []
        : [{ typeId: descriptor.id, entityId: null, label: descriptor.label }];
    }

    if (separator === 0 || separator === segment.length - 1) {
      return [];
    }

    const descriptor = findEntityType(segment.slice(0, separator));
    const entityId = segment.slice(separator + 1);
    if (descriptor === undefined || entityId.length === 0) {
      return [];
    }

    return [{ typeId: descriptor.id, entityId, label: 'Loading…' }];
  });
}

/**
 * Route parameters for the explorer.
 */
export interface ExplorerRouteState {
  /**
   * Selected collection, or `null` for the welcome state.
   */
  typeId: EntityTypeId | null;
  /**
   * Selected entity, or `null` when only a collection is selected.
   */
  entityId: string | null;
  /**
   * Restored traversal path, excluding the selected entity when it is already its final step.
   */
  trail: TrailStep[];
}

/**
 * Interpret a route as explorer state.
 *
 * @param route Current route.
 * @returns Safe state for the explorer. Unknown type identifiers become the welcome state; a
 *   malformed entity identifier is still passed through so the API can answer the honest "record no
 *   longer exists" state rather than the client inventing a validation rule for UUIDs.
 */
export function routeState(route: RouteLocationNormalizedLoaded): ExplorerRouteState {
  const rawType = typeof route.params.type === 'string' ? route.params.type : undefined;
  const descriptor = rawType === undefined ? undefined : findEntityType(rawType);
  if (descriptor === undefined) {
    return { typeId: null, entityId: null, trail: [] };
  }

  const entityId = typeof route.params.id === 'string' ? route.params.id : null;
  const encoded = typeof route.query.trail === 'string' ? route.query.trail : undefined;
  const decoded = decodeTrail(encoded);

  // The current entity is represented by the path itself. Avoid duplicating it if it is also the
  // final encoded trail step — an encoded trail normally includes it so its display label can be
  // restored after loading, but the view adds it from the pathname.
  const trail =
    entityId !== null
    && decoded.at(-1)?.typeId === descriptor.id
    && decoded.at(-1)?.entityId === entityId
      ? decoded.slice(0, -1)
      : decoded;

  return { typeId: descriptor.id, entityId, trail };
}

/**
 * Browser router for the explorer.
 *
 * The two route forms are intentionally shallow: `/planets` names a collection and `/planets/<id>`
 * names one record. The breadcrumb's true graph path is carried in `trail`, because forcing it into
 * nested pathname segments would pretend the graph is a tree and make every link grow indefinitely.
 * This preserves the shareable, reloadable state UISPEC §8.1 requires while keeping a URL a person
 * can read.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { component: ExplorerView, path: '/' },
    { component: ExplorerView, path: '/:type' },
    { component: ExplorerView, path: '/:type/:id' },
    { component: ExplorerView, path: '/:pathMatch(.*)*' }
  ]
});

/**
 * Build a location for a collection or entity plus its traversal history.
 *
 * @param typeId Selected type, or `null` for the welcome state.
 * @param entityId Selected entity, or `null` for only a collection.
 * @param trail Full current trail, including the selected entity if any.
 * @returns Router location suitable for `push` or `replace`.
 */
export function explorerLocation(
  typeId: EntityTypeId | null,
  entityId: string | null,
  trail: readonly TrailStep[]
): { path: string; query?: { trail: string } } {
  if (typeId === null) {
    return { path: '/' };
  }

  const path = entityId === null ? `/${typeId}` : `/${typeId}/${encodeURIComponent(entityId)}`;
  const encodedTrail = encodeTrail(trail);
  return encodedTrail === undefined ? { path } : { path, query: { trail: encodedTrail } };
}

/**
 * Get the collection label for a type.
 *
 * @param typeId Entity type.
 * @returns Its plural collection label.
 */
export function collectionLabel(typeId: EntityTypeId): string {
  return ENTITY_TYPES[typeId].label;
}
