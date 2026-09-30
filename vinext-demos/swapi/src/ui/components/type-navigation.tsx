'use client';

import { ENTITY_TYPES, ENTITY_TYPE_IDS, type EntityTypeId } from '../domain/entity-types';

/**
 * Props for {@link TypeNavigation}.
 */
export interface TypeNavigationProps {
  /**
   * Currently selected collection, or `null` at the welcome state.
   */
  selected: EntityTypeId | null;
  /**
   * Called when the user chooses a collection.
   *
   * @param typeId Collection that was chosen.
   */
  onSelect: (typeId: EntityTypeId) => void;
}

/**
 * The narrow first column: one entry per entity type.
 *
 * A `nav` landmark containing a real list, because UISPEC §14 requires the columns to be landmarks
 * and the lists to be lists. Each entry is a `button` rather than a link even though it changes the
 * URL: the parent performs the navigation so that every selection follows one code path (UISPEC
 * §8), and a link here would give this column a second, subtly different one. Selection is conveyed
 * with `aria-current` rather than colour alone.
 *
 * @param props Selected collection and the selection callback.
 * @returns The navigation column.
 */
export function TypeNavigation({ selected, onSelect }: TypeNavigationProps): React.JSX.Element {
  return (
    <nav aria-label="Collections" className="navigation">
      <h2 className="column-heading">Explore</h2>
      <ul className="navigation-list">
        {ENTITY_TYPE_IDS.map((typeId) => (
          <li key={typeId}>
            <button
              type="button"
              className="navigation-item"
              aria-current={selected === typeId ? 'true' : undefined}
              onClick={() => onSelect(typeId)}
            >
              {ENTITY_TYPES[typeId].label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
