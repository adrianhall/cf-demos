'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ENTITY_TYPES, type EntityTypeId } from '../domain/entity-types';
import { scalarText } from '../domain/scalar-text';
import type { EntitySummary } from '../state/catalog-store';
import {
  collectionTrail,
  labelStep,
  PLACEHOLDER_LABEL,
  selectEntity as extendTrail,
  truncateTrail,
  type TrailStep
} from '../state/trail';
import { explorerHref, readLocation, TRAIL_PARAM } from '../state/trail-url';
import { CatalogProvider, useCatalogStore } from '../state/use-catalog';
import { CollectionColumn } from './collection-column';
import { EntityDetail } from './entity-detail';
import { ExplorerBanner } from './explorer-banner';
import { TypeNavigation } from './type-navigation';

/**
 * Read the explorer's position from the current URL.
 *
 * The URL is the single source of truth for where the user is (UISPEC §8.1), so this is derived on
 * every render rather than mirrored into state. Keeping a copy in `useState` would create two
 * places that can disagree, and browser back/forward would update only one of them.
 *
 * @param pathname Current pathname, from which the type and entity segments are taken.
 * @param encodedTrail Value of the `trail` query parameter.
 * @returns The selected type, selected entity, and restored traversal path.
 */
function useExplorerLocation(
  pathname: string,
  encodedTrail: string | null
): ReturnType<typeof readLocation> {
  return useMemo(() => {
    const [rawType, rawId] = pathname.split('/').filter((segment) => segment.length > 0);
    return readLocation(rawType, rawId, encodedTrail);
  }, [pathname, encodedTrail]);
}

/**
 * The explorer, and the composition root for the UI tier.
 *
 * The only thing this outer component does is own the session cache, which is what makes it the one
 * place the UI tier is composed — mirroring how `src/worker/index.ts` composes the tiers below it.
 * Everything else is in {@link ExplorerShell}.
 *
 * @returns The explorer, with its catalog in scope.
 */
export function ExplorerApp(): React.JSX.Element {
  return (
    <CatalogProvider>
      <ExplorerShell />
    </CatalogProvider>
  );
}

/**
 * The three columns, and the one component that owns navigation.
 *
 * Every click that changes what is being looked at — a navigation entry, a collection row, a
 * relation panel entry, a global search result, a breadcrumb segment — is handled here and turned
 * into exactly one URL change. That centralisation is UISPEC §8's single navigation rule expressed
 * as code: no surface can develop its own idea of what selecting an entity means, because no
 * surface performs the navigation itself.
 *
 * @returns The banner and three columns.
 */
export function ExplorerShell(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const catalog = useCatalogStore();

  const location = useExplorerLocation(pathname, searchParams?.get(TRAIL_PARAM) ?? null);
  const { typeId, entityId } = location;

  // The trail restored from the URL, plus the selected entity the pathname names. Held in state
  // rather than derived, because labels arrive asynchronously: the URL carries identifiers only,
  // and the hydration effect below fills in real names as records load.
  const [trail, setTrail] = useState<readonly TrailStep[]>([]);

  // Filter text per collection. Stored per type, which is what makes UISPEC §5.2's two rules fall
  // out naturally: the filter persists while the user moves between entities of the same type, and
  // a different type simply has a different entry.
  const [filters, setFilters] = useState<Readonly<Partial<Record<EntityTypeId, string>>>>({});

  useEffect(() => {
    if (typeId === null) {
      setTrail([]);
      return;
    }

    // A URL restored from `trail` already holds the originating collection (and any intermediate
    // entities). A fresh `/people/<id>` has no trail, so seed it with the collection the pathname
    // names. Avoid adding it a second time in the former case: a breadcrumb must describe the path
    // actually taken, not repeat the first step because it happened to match the terminal type.
    const steps: TrailStep[] =
      location.trail.length > 0
        ? [...location.trail]
        : collectionTrail(typeId, ENTITY_TYPES[typeId].label);
    if (entityId !== null) {
      steps.push({ typeId, entityId, label: PLACEHOLDER_LABEL });
    }

    // Preserve labels already known from a previous position, so a breadcrumb segment does not
    // flicker back to the placeholder while its record is re-read from cache.
    setTrail((previous) =>
      steps.map((step) => {
        const known = previous.find(
          (candidate) =>
            candidate.typeId === step.typeId
            && candidate.entityId === step.entityId
            && candidate.label !== PLACEHOLDER_LABEL
        );
        return known ?? step;
      })
    );
  }, [typeId, entityId, location.trail]);

  // A deep link preserves entity identifiers but not their display names, and duplicating names
  // into the query string would mean rendering untrusted text as a breadcrumb. Load each entity in
  // the restored path instead and take the label from the authoritative record. The cache makes
  // this free for anything already visited, and every fetch starts together so a long breadcrumb
  // does not make a reload slow.
  useEffect(() => {
    const pending = trail.filter(
      (step): step is TrailStep & { entityId: string } =>
        step.entityId !== null && step.label === PLACEHOLDER_LABEL
    );
    if (pending.length === 0) {
      return;
    }

    void Promise.all(
      pending.map(async (step) => {
        await catalog.loadEntity(step.typeId, step.entityId);
        const record = catalog.entityState(step.typeId, step.entityId).value;
        if (record === null) {
          return;
        }

        const label = scalarText(record[ENTITY_TYPES[step.typeId].displayField], 'Unnamed record');
        // `labelStep` returns the same array for a no-op, and React skips a re-render when the
        // state is identical — which is what stops this effect from retriggering itself. See the
        // note in `../state/trail.ts`.
        setTrail((previous) => labelStep(previous, step.typeId, step.entityId, label));
      })
    );
  }, [trail, catalog]);

  // Focus moves to the new detail heading after the columns are replaced (UISPEC §14), but only
  // for a navigation the user performed — never on first load or on a browser back/forward, where
  // stealing focus would be unexpected. The ref records that intent at the moment of the click.
  const shouldFocusHeading = useRef(false);

  const navigate = useCallback(
    (
      nextTypeId: EntityTypeId | null,
      nextEntityId: string | null,
      nextTrail: readonly TrailStep[],
      options?: { focusHeading?: boolean }
    ): void => {
      shouldFocusHeading.current = options?.focusHeading ?? false;
      setTrail(nextTrail);
      router.push(explorerHref(nextTypeId, nextEntityId, nextTrail));
    },
    [router]
  );

  /**
   * Begin a new line of enquiry at a collection.
   *
   * Resets the trail and clears that collection's filter, because choosing a type in the navigation
   * column is a fresh start rather than a continuation (UISPEC §8, §5.2).
   *
   * @param nextTypeId Collection to select.
   */
  const selectCollection = useCallback(
    (nextTypeId: EntityTypeId): void => {
      setFilters((previous) => ({ ...previous, [nextTypeId]: '' }));
      navigate(nextTypeId, null, collectionTrail(nextTypeId, ENTITY_TYPES[nextTypeId].label));
    },
    [navigate]
  );

  /**
   * Open an entity, extending or truncating the trail as UISPEC §8 requires.
   *
   * @param nextTypeId Type of the entity being opened.
   * @param item Summary of the entity, whose title becomes the breadcrumb label.
   */
  const selectEntity = useCallback(
    (nextTypeId: EntityTypeId, item: EntitySummary): void => {
      const next = extendTrail(
        trail,
        nextTypeId,
        item.id,
        item.title,
        ENTITY_TYPES[nextTypeId].label
      );
      navigate(nextTypeId, item.id, next, { focusHeading: true });
    },
    [navigate, trail]
  );

  /**
   * Open an entity chosen from global search, starting a fresh line of enquiry.
   *
   * Distinct from {@link selectEntity} because a search result is not a continuation of whatever
   * relation path happened to be open underneath the results popover (UISPEC §7). The selected
   * entity still needs its collection as the first breadcrumb step, so both are set explicitly.
   *
   * @param nextTypeId Type of the chosen entity.
   * @param item Summary of the chosen entity.
   */
  const chooseSearchResult = useCallback(
    (nextTypeId: EntityTypeId, item: EntitySummary): void => {
      navigate(
        nextTypeId,
        item.id,
        [
          { typeId: nextTypeId, entityId: null, label: ENTITY_TYPES[nextTypeId].label },
          { typeId: nextTypeId, entityId: item.id, label: item.title }
        ],
        { focusHeading: true }
      );
    },
    [navigate]
  );

  /**
   * Return to an earlier point in the trail, discarding everything after it.
   *
   * @param index Position in the trail that was clicked.
   */
  const returnTo = useCallback(
    (index: number): void => {
      const next = truncateTrail(trail, index);
      const step = next.at(-1);
      navigate(step?.typeId ?? null, step?.entityId ?? null, next, { focusHeading: true });
    },
    [navigate, trail]
  );

  /**
   * Set the filter text for one collection.
   *
   * @param forTypeId Collection the filter belongs to.
   * @param value Filter text as typed.
   */
  const setFilter = useCallback((forTypeId: EntityTypeId, value: string): void => {
    setFilters((previous) => ({ ...previous, [forTypeId]: value }));
  }, []);

  return (
    <div className="explorer">
      <ExplorerBanner onChoose={chooseSearchResult} />
      <div className="explorer-grid">
        <TypeNavigation selected={typeId} onSelect={selectCollection} />
        <CollectionColumn
          typeId={typeId}
          selectedId={entityId}
          filter={typeId === null ? '' : (filters[typeId] ?? '')}
          onFilterChange={setFilter}
          onSelect={selectEntity}
        />
        <EntityDetail
          typeId={typeId}
          entityId={entityId}
          trail={trail}
          focusHeading={shouldFocusHeading}
          onSelect={selectEntity}
          onReturnTo={returnTo}
        />
      </div>
    </div>
  );
}
