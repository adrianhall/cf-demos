'use client';

import { useEffect, useId, useMemo, useRef } from 'react';
import { ENTITY_TYPES, type EntityTypeId } from '../domain/entity-types';
import type { EntitySummary } from '../state/catalog-store';
import { useCollection, useRetry } from '../state/use-catalog';

/**
 * Props for {@link CollectionColumn}.
 */
export interface CollectionColumnProps {
  /**
   * Collection being shown, or `null` at the welcome state.
   */
  typeId: EntityTypeId | null;
  /**
   * Currently selected entity, or `null` when none is open.
   */
  selectedId: string | null;
  /**
   * Current filter text for this collection.
   */
  filter: string;
  /**
   * Called as the user types in the filter.
   *
   * @param typeId Collection the filter belongs to.
   * @param value New filter text.
   */
  onFilterChange: (typeId: EntityTypeId, value: string) => void;
  /**
   * Called when the user picks a row.
   *
   * @param typeId Type of the chosen entity.
   * @param item Summary of the chosen entity.
   */
  onSelect: (typeId: EntityTypeId, item: EntitySummary) => void;
}

/**
 * The middle column: a filterable list of one collection.
 *
 * The filter is client-side and deliberately so. The largest collection is 82 rows and the column
 * already holds all of them, so narrowing them is instant — whereas a request per keystroke would
 * add latency to the one interaction UISPEC §5.2 requires to feel immediate. Server-side `search`
 * is used where the client genuinely cannot filter: global search, in the banner.
 *
 * @param props Collection, selection, filter, and their callbacks.
 * @returns The collection column.
 */
export function CollectionColumn({
  typeId,
  selectedId,
  filter,
  onFilterChange,
  onSelect
}: CollectionColumnProps): React.JSX.Element {
  const state = useCollection(typeId);
  const retry = useRetry(typeId, null);
  const filterId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const descriptor = typeId === null ? null : ENTITY_TYPES[typeId];
  const items = state.value ?? [];
  const term = filter.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      term.length === 0
        ? items
        : items.filter((item) => item.title.toLocaleLowerCase().includes(term)),
    [items, term]
  );

  // The list is an independently scrolling surface, and arriving from a relation panel changes the
  // selected type and entity at once — so a selected row is frequently off-screen at the moment it
  // becomes selected. Watching the rendered row identifiers as well as the selection covers the
  // case where the selection arrives before the collection it belongs to has loaded.
  const renderedIds = visible.map((item) => item.id).join(',');
  useEffect(() => {
    if (selectedId === null) {
      return;
    }

    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-entity-id="${CSS.escape(selectedId)}"]`
    );
    // `block: 'nearest'` matters: an already-visible row stays exactly where it is, and an
    // off-screen one moves only far enough to be revealed rather than jumping to the top. Focus
    // is deliberately not moved — it belongs in the detail heading (UISPEC §14), and scrolling is
    // visual context rather than a focus change.
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, renderedIds]);

  if (descriptor === null) {
    return (
      <section aria-label="Collection" className="collection">
        <p className="empty-note">Choose a collection to browse its records.</p>
      </section>
    );
  }

  const plural = descriptor.label.toLocaleLowerCase();

  return (
    <section aria-label="Collection" className="collection">
      <header className="collection-header">
        <h2 className="collection-title">{descriptor.label}</h2>
        {/*
          `12 of 82` rather than a bare count, so the filter's effect is legible at a glance
          (UISPEC §5.2). Announced politely because it changes as the user types, and a silent
          count would leave a screen-reader user unable to tell whether the filter did anything.
        */}
        <span aria-live="polite" className="result-count">
          {visible.length} of {items.length}
        </span>
      </header>

      <div className="collection-filter">
        <label className="sr-only" htmlFor={filterId}>
          Filter {plural}
        </label>
        <input
          id={filterId}
          type="search"
          aria-label={`Filter ${plural}`}
          value={filter}
          placeholder="Filter this list"
          onChange={(event) => onFilterChange(descriptor.id, event.target.value)}
        />
      </div>

      {state.loading ? (
        <p className="empty-note" role="status">
          Loading {plural}…
        </p>
      ) : state.error !== null ? (
        <div className="panel-error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-note">
          {term.length > 0 ? (
            <>
              {/* Naming the term and offering to clear it, rather than leaving the user staring
                  at an empty list wondering whether it failed (UISPEC §9.3). */}
              <p>
                No {plural} match “{filter}”.
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => onFilterChange(descriptor.id, '')}
              >
                Clear filter
              </button>
            </>
          ) : (
            <p>No {plural} are available.</p>
          )}
        </div>
      ) : (
        <ul className="entity-list" ref={listRef}>
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="entity-row"
                data-entity-id={item.id}
                aria-current={item.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(descriptor.id, item)}
              >
                <span className="entity-row-title">{item.title}</span>
                <span className="entity-row-subtitle">{item.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
