/**
 * @file Encoding the explorer's position into a URL and reading it back. UISPEC §8.1 requires that
 *   any state reachable by clicking is reachable by URL: without it a user cannot share "look at
 *   this", browser back/forward do not work, and a reload loses their place. That means the URL has
 *   to carry three things — the selected type, the selected entity, and enough of the trail to
 *   reconstruct the breadcrumb. The first two are the pathname (`/planets/<id>`), which keeps a URL
 *   a person can read. The trail is a query parameter instead, because forcing a graph path into
 *   nested pathname segments would pretend the graph is a tree and make every link grow without
 *   bound.
 */

import { findEntityType, type EntityTypeId } from '../domain/entity-types';
import { PLACEHOLDER_LABEL, type TrailStep } from './trail';

/**
 * Query parameter carrying the encoded traversal path.
 */
export const TRAIL_PARAM = 'trail';

/**
 * Delimiter separating steps in the encoded path.
 *
 * Entity identifiers are UUIDs, which never contain `~`, so a compact path is unambiguous without
 * putting JSON into an address bar. A collection step is its type (`films`); an entity step is
 * `type:id`.
 */
const TRAIL_SEPARATOR = '~';

/**
 * Encode an exploration trail for the address bar.
 *
 * A collection-only trail has no entity path to preserve and is omitted, keeping fresh collection
 * URLs clean (`/people`, not `/people?trail=people`). Once the user opens an entity, every step —
 * including its originating collection — is encoded so a reload can reconstruct the honest
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
 * Invalid segments are skipped rather than making a shared URL unusable. A URL is user-editable and
 * may have been copied through something that truncated a query string; preserving the valid steps
 * is friendlier than rejecting the whole location because one tail segment is malformed. Labels are
 * placeholders until their records load, at which point the explorer replaces them with real
 * display names.
 *
 * @param encoded Value of the `trail` query parameter.
 * @returns Valid steps in order; an empty array when the parameter is absent or wholly malformed.
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

    return [{ typeId: descriptor.id, entityId, label: PLACEHOLDER_LABEL }];
  });
}

/**
 * The explorer's position, as read from a route.
 */
export interface ExplorerLocation {
  /**
   * Selected collection, or `null` for the welcome state.
   */
  typeId: EntityTypeId | null;
  /**
   * Selected entity, or `null` when only a collection is selected.
   */
  entityId: string | null;
  /**
   * Restored traversal path, **excluding** the selected entity: the pathname already names it, and
   * the view appends it from there.
   */
  trail: TrailStep[];
}

/**
 * Interpret route parameters as explorer state.
 *
 * @param rawType `type` route parameter, or `undefined` at the root.
 * @param rawId `id` route parameter, or `undefined` when only a collection is selected.
 * @param encodedTrail Value of the `trail` query parameter.
 * @returns Safe state for the explorer. An unknown type identifier becomes the welcome state; a
 *   malformed entity identifier is passed through unchanged so the API can answer the honest
 *   "record no longer exists" state, rather than the client inventing a validation rule for UUIDs.
 */
export function readLocation(
  rawType: string | undefined,
  rawId: string | undefined,
  encodedTrail: string | null | undefined
): ExplorerLocation {
  const descriptor = rawType === undefined ? undefined : findEntityType(rawType);
  if (descriptor === undefined) {
    return { typeId: null, entityId: null, trail: [] };
  }

  const entityId = rawId ?? null;
  const decoded = decodeTrail(encodedTrail);

  // The current entity is represented by the pathname. Avoid duplicating it when it is also the
  // final encoded step — an encoded trail normally includes it so its label can be restored after
  // loading, but the view re-adds it from the pathname.
  const last = decoded.at(-1);
  const trail =
    entityId !== null && last?.typeId === descriptor.id && last.entityId === entityId
      ? decoded.slice(0, -1)
      : decoded;

  return { typeId: descriptor.id, entityId, trail };
}

/**
 * Build the href for a collection or entity plus its traversal history.
 *
 * @param typeId Selected type, or `null` for the welcome state.
 * @param entityId Selected entity, or `null` for only a collection.
 * @param trail Full current trail, including the selected entity if any.
 * @returns A root-relative href suitable for a link or a router navigation.
 */
export function explorerHref(
  typeId: EntityTypeId | null,
  entityId: string | null,
  trail: readonly TrailStep[]
): string {
  if (typeId === null) {
    return '/';
  }

  const path = entityId === null ? `/${typeId}` : `/${typeId}/${encodeURIComponent(entityId)}`;
  const encoded = encodeTrail(trail);
  return encoded === undefined ? path : `${path}?${TRAIL_PARAM}=${encodeURIComponent(encoded)}`;
}
