import { useState } from 'react';
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  getNodesByCategory,
  type NodeCategory,
  type NodeTypeDef
} from '../../../../catalog.ts';
import {
  getStoredCollapsedCategories,
  setStoredCollapsedCategories
} from '../../../lib/palette-preferences.ts';
import { ProductIcon } from '../../ProductIcon.tsx';

/**
 * The catalogue grouped by category, computed once at module load.
 *
 * The catalogue is a static module, so this cannot change between renders — recomputing it per
 * mount would walk 42 products to produce the same object.
 */
const grouped = getNodesByCategory();

/**
 * Category keys present in {@link grouped}, in catalogue order.
 */
const categories = Object.keys(grouped) as NodeCategory[];

/**
 * Props for {@link PaletteItem}.
 */
interface PaletteItemProps {
  /**
   * Catalogue entry this item offers.
   */
  node: NodeTypeDef;
  /**
   * Called when a drag starts, to attach the type to the drag's transfer data.
   */
  onDragStart: (event: React.DragEvent, typeId: string) => void;
  /**
   * Called when the item is clicked or activated from the keyboard.
   */
  onAddNode: (typeId: string) => void;
}

/**
 * One service in the palette: draggable onto the canvas, and activatable without a pointer.
 *
 * A real `<button>` rather than a `draggable` div, because drag-and-drop is not a keyboard
 * interaction: without this, adding a node — the editor's primary action — would be unreachable
 * from the keyboard and from switch access entirely.
 *
 * The description is rendered as visible text as well as a `title`, since a native tooltip needs a
 * mouse to hover with. It is linked by `aria-describedby` rather than folded into the accessible
 * name, so a screen reader announces "Workers, button" and then the description, instead of one
 * run-on sentence as the control's name.
 *
 * @param props Catalogue entry and handlers; see {@link PaletteItemProps}.
 * @returns The palette entry.
 */
function PaletteItem({ node, onDragStart, onAddNode }: PaletteItemProps) {
  const descriptionId = `palette-item-description-${node.typeId}`;

  return (
    <button
      type="button"
      className="service-palette__item"
      draggable
      onDragStart={(event) => onDragStart(event, node.typeId)}
      onClick={() => onAddNode(node.typeId)}
      title={`${node.description} (drag onto the canvas, or activate to add at the center)`}
      aria-label={node.label}
      aria-describedby={descriptionId}
    >
      <ProductIcon icon={node.icon} size={20} color={CATEGORY_COLORS[node.category]} />
      <span className="service-palette__item-text">
        <span className="service-palette__item-label" aria-hidden="true">
          {node.label}
        </span>
        <span id={descriptionId} className="service-palette__item-description">
          {node.description}
        </span>
      </span>
    </button>
  );
}

/**
 * Props for {@link ServicePalette}.
 */
export interface ServicePaletteProps {
  /**
   * Called with a catalogue `typeId` when an item is clicked or activated from the keyboard. The
   * canvas owns where the new node lands, because only it knows the viewport.
   */
  onAddNode: (typeId: string) => void;
}

/**
 * The editor's left sidebar: every catalogue service, grouped, searchable and collapsible.
 *
 * Which categories are collapsed is persisted per visitor, so the palette opens the way it was left
 * rather than resetting to six expanded sections of 42 products on every load.
 *
 * A search always expands every matching category, whatever its stored state. A visitor who types a
 * product name is asking to see it, and honouring a collapsed section at that point would show them
 * a header with their result hidden underneath it.
 *
 * @param props Add handler; see {@link ServicePaletteProps}.
 * @returns The service palette.
 */
export function ServicePalette({ onAddNode }: ServicePaletteProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(getStoredCollapsedCategories);

  const filterTerm = search.toLowerCase().trim();

  /**
   * Attaches the dragged service's type to the drag, for the canvas's drop handler to read.
   *
   * @param event Drag event from the item.
   * @param typeId Catalogue type being dragged.
   * @returns Nothing.
   */
  const onDragStart = (event: React.DragEvent, typeId: string): void => {
    event.dataTransfer.setData('application/cf-node-type', typeId);
    event.dataTransfer.effectAllowed = 'move';
  };

  /**
   * Collapses or expands one category, persisting the result.
   *
   * @param category Category that was clicked.
   * @returns Nothing.
   */
  const toggleCategory = (category: string): void => {
    setCollapsed((previous) => {
      const next = { ...previous, [category]: !previous[category] };
      setStoredCollapsedCategories(next);
      return next;
    });
  };

  // Reflects the stored preference rather than what is currently on screen: a search force-expands
  // every matching category, and the control must still offer to collapse what the visitor has
  // actually chosen to leave open.
  const allCollapsed = categories.every((category) => collapsed[category]);

  /**
   * Collapses or expands every category at once, persisting the result.
   *
   * @returns Nothing.
   */
  const toggleAllCategories = (): void => {
    const next = !allCollapsed;
    const nextCollapsed = Object.fromEntries(categories.map((category) => [category, next]));
    setStoredCollapsedCategories(nextCollapsed);
    setCollapsed(nextCollapsed);
  };

  return (
    <aside className="service-palette" aria-label="Service palette">
      <div className="service-palette__header">
        <div className="service-palette__header-row">
          <h2 className="service-palette__title">Services</h2>
          <button
            type="button"
            className="service-palette__collapse-all"
            onClick={toggleAllCategories}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
        <label className="visually-hidden" htmlFor="palette-search">
          Search services
        </label>
        <input
          id="palette-search"
          type="text"
          placeholder="Search services…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="service-palette__search"
        />
      </div>

      <div className="service-palette__list">
        {categories.map((category) => {
          const items = grouped[category].filter(
            (node) =>
              !filterTerm
              || node.label.toLowerCase().includes(filterTerm)
              || node.typeId.toLowerCase().includes(filterTerm)
          );
          // A category with no match is dropped entirely rather than shown empty, so a search
          // narrows the list instead of leaving a column of empty headers behind.
          if (items.length === 0) {
            return null;
          }

          // A search always wins over the stored state: somebody who types a product name is
          // asking to see it, not to be shown a header with their result hidden underneath.
          const isCollapsed = collapsed[category] && !filterTerm;

          return (
            <div key={category} className="service-palette__category">
              <button
                type="button"
                className="service-palette__category-header"
                onClick={() => toggleCategory(category)}
                aria-expanded={!isCollapsed}
                style={{ borderLeftColor: CATEGORY_COLORS[category] }}
              >
                <span>{CATEGORY_LABELS[category]}</span>
                <span aria-hidden="true">{isCollapsed ? '+' : '\u2013'}</span>
              </button>

              {!isCollapsed && (
                <div className="service-palette__items">
                  {items.map((node) => (
                    <PaletteItem
                      key={node.typeId}
                      node={node}
                      onDragStart={onDragStart}
                      onAddNode={onAddNode}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
