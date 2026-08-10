import { useState } from "react";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  getNodesByCategory,
  type NodeCategory,
  type NodeTypeDef,
} from "../../../../catalog";

/** Every catalog node type grouped by category, computed once at module load. */
const grouped = getNodesByCategory();
/** Category keys present in {@link grouped}, in catalog-declaration order. */
const categories = Object.keys(grouped) as NodeCategory[];

/**
 * Left sidebar listing every catalog node type grouped by category, with a type-ahead search
 * filter and collapsible category sections. Ported from CF-Architect's
 * `src/islands/panels/ServicePalette.tsx`, with one deliberate accessibility addition: each item
 * is a real `<button>` that also calls `onAddNode` on click/keyboard activation, not only a
 * `draggable` `<div>` -- CF-Architect's drag-only palette has no keyboard or screen-reader path
 * to add a node at all, which AGENTS.md's WCAG 2.2 AA requirement for this demo's primary
 * workflow does not allow.
 *
 * @param onAddNode Called with a clicked/activated item's `typeId`; the caller
 * (`../DiagramCanvas.tsx`) adds the node at a sensible default position.
 */
export function ServicePalette({
  onAddNode,
}: {
  onAddNode: (typeId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filterTerm = search.toLowerCase().trim();

  /** Attach the dragged node's catalog `typeId` as transfer data for the canvas's `onDrop`. */
  const onDragStart = (event: React.DragEvent, typeId: string) => {
    event.dataTransfer.setData("application/cf-node-type", typeId);
    event.dataTransfer.effectAllowed = "move";
  };

  const toggleCategory = (category: string) => {
    setCollapsed((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  return (
    <aside className="service-palette" aria-label="Service palette">
      <div className="service-palette__header">
        <h2 className="service-palette__title">Services</h2>
        <label
          className="service-palette__search-label"
          htmlFor="palette-search"
        >
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
              !filterTerm ||
              node.label.toLowerCase().includes(filterTerm) ||
              node.typeId.toLowerCase().includes(filterTerm),
          );
          if (items.length === 0) return null;

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
                <span aria-hidden="true">{isCollapsed ? "+" : "\u2013"}</span>
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

/**
 * A single draggable, and clickable/keyboard-activatable, palette entry. Dragging it onto the
 * canvas positions the new node at the drop point (`../DiagramCanvas.tsx`'s `onDrop`); clicking
 * or pressing Enter/Space adds it at a default position via `onAddNode` -- the keyboard/
 * screen-reader equivalent of the same action.
 */
function PaletteItem({
  node,
  onDragStart,
  onAddNode,
}: {
  node: NodeTypeDef;
  onDragStart: (event: React.DragEvent, typeId: string) => void;
  onAddNode: (typeId: string) => void;
}) {
  return (
    <button
      type="button"
      className="service-palette__item"
      draggable
      onDragStart={(event) => onDragStart(event, node.typeId)}
      onClick={() => onAddNode(node.typeId)}
      title={`${node.description} (drag onto the canvas, or activate to add at the center)`}
    >
      <img src={node.iconPath} alt="" width={20} height={20} />
      <span>{node.label}</span>
    </button>
  );
}
